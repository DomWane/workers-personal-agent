import json
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, NamedTuple, TypedDict

from lib.corpus import CORPUS, Chunk, EmbeddingsIndex
from lib.env import load_dotenv
from lib.http import HttpError, dig, post_json_with_retry
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from lib.vectors import unpack_vectors
from retrievers.dense import DenseRetriever
from run_retrieval import Labelled, assert_dense_inputs_fresh

SET = 'bulk' if os.environ.get('EVAL_SET') == 'bulk' else 'hard'
RUN_TAG = os.environ.get('EVAL_RUN_TAG', 'hfe')
OUT = DATA / f'model-runs.{RUN_TAG}.{SET}.jsonl'
TEMPERATURE = float(os.environ.get('MODEL_TEMPERATURE', '1.0'))
TOP_P = float(os.environ.get('MODEL_TOP_P', '0.95'))
SAMPLE_TOP_K = int(os.environ.get('MODEL_TOP_K', '20'))
MIN_P = float(os.environ.get('MODEL_MIN_P', '0'))
SEEDS = [int(x) for x in os.environ.get('MODEL_SEEDS', '1,2,3').split(',')]
ONLY = os.environ.get('EVAL_ONLY')
TOP_K = 5
MAX_TOKENS = int(os.environ.get('MODEL_MAX_TOKENS', '24576'))

SYSTEM = ' '.join(
    [
        'Odpovídej česky a pouze na základě přiložených úryvků.',
        'Když v nich odpověď není, napiš to — nedomýšlej si.',
    ]
)

THINK_OPEN = '<think>'
THINK_CLOSE = '</think>'


class Run(TypedDict):
    query: str
    model: str
    seed: int
    answer: str
    reasoningTokens: int | None
    reasoningChars: int
    completionTokens: int | None
    promptTokens: int | None
    latencyMs: float
    finishReason: str | None
    provider: str | None
    generationId: str | None
    contextIds: list[str]


def build_prompt(query: str, context: list[Chunk]) -> str:
    blocks = [f'--- úryvek {i} ({c.ts[:10]}) ---\n{c.text}' for i, c in enumerate(context, start=1)]
    return '\n\n'.join(blocks) + f'\n\nOTÁZKA: {query}'


def run_key(model: str, query: str, seed: int = 0) -> str:
    return '\0'.join([str(seed), model, query])


def done_keys(path: Path) -> set[str]:
    return {run_key(r['model'], r['query'], r.get('seed', 0)) for r in read_json_lines(path)}


def reasoning_tokens_of(usage: Mapping[str, object] | None) -> int | None:
    v = dig(usage, 'completion_tokens_details', 'reasoning_tokens')
    if v is None:
        v = dig(usage, 'reasoning_tokens')
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def reasoning_text_of(message: Mapping[str, object] | None) -> str:
    text = dig(message, 'reasoning')
    if not isinstance(text, str):
        text = dig(message, 'reasoning_content')
    return text if isinstance(text, str) else ''


class Split(NamedTuple):
    answer: str
    thinking: str


def split_thinking(content: str) -> Split:
    thinking: list[str] = []
    answer = ''
    first_close = content.find(THINK_CLOSE)
    first_open = content.find(THINK_OPEN)
    rest = (
        THINK_OPEN + content
        if first_close != -1 and (first_open == -1 or first_close < first_open)
        else content
    )
    while True:
        open_at = rest.find(THINK_OPEN)
        if open_at == -1:
            answer += rest
            break
        answer += rest[:open_at]
        after = rest[open_at + len(THINK_OPEN) :]
        close_at = after.find(THINK_CLOSE)
        if close_at == -1:
            thinking.append(after.strip())
            break
        thinking.append(after[:close_at].strip())
        rest = after[close_at + len(THINK_CLOSE) :]
    return Split(answer.strip(), '\n'.join(thinking))


class Separated(NamedTuple):
    answer: str
    reasoning_text: str


def separate_trace(message: Mapping[str, object] | None, finish_reason: str | None) -> Separated:
    content = dig(message, 'content')
    content = content if isinstance(content, str) else ''
    from_field = reasoning_text_of(message)
    if finish_reason == 'length' and not from_field and THINK_CLOSE not in content:
        return Separated('', content.strip())
    split = split_thinking(content)
    return Separated(split.answer, from_field or split.thinking)


Label = Literal['base', 'tuned']


class Endpoint(NamedTuple):
    label: Label
    base: str
    key: str
    model: str


def endpoints_from_env(env: Mapping[str, str]) -> list[Endpoint]:
    def read(prefix: str, label: Label) -> Endpoint:
        base = env.get(f'{prefix}_API_BASE')
        key = env.get(f'{prefix}_API_KEY') or env.get('HF_TOKEN')
        model = env.get(f'{prefix}_MODEL')
        if not base or not key or not model:
            raise SystemExit(f'set {prefix}_API_BASE, {prefix}_API_KEY and {prefix}_MODEL')
        return Endpoint(label, base, key, model)

    only = env.get('EVAL_ONLY')
    return [e for e in (read('BASE', 'base'), read('TUNED', 'tuned')) if not only or e.label == only]


class Reply(NamedTuple):
    answer: str
    reasoning_text: str
    usage: Mapping[str, object] | None
    finish_reason: str | None
    latency_ms: float
    provider: str | None
    generation_id: str | None


def ask(prompt: str, ep: Endpoint, seed: int) -> Reply:
    t0 = time.perf_counter()
    try:
        data = post_json_with_retry(
            f'{ep.base.rstrip("/")}/chat/completions',
            {
                'model': ep.model,
                'include_reasoning': True,
                'temperature': TEMPERATURE,
                'top_p': TOP_P,
                'top_k': SAMPLE_TOP_K,
                'min_p': MIN_P,
                'seed': seed,
                'max_tokens': MAX_TOKENS,
                'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}],
            },
            ep.key,
            ep.model,
        )
    except HttpError as err:
        raise RuntimeError(f'{ep.model} {err.status}: {err.body[:400]}') from err
    message: Mapping[str, object] | None = dig(data, 'choices', 0, 'message')
    finish_reason: str | None = dig(data, 'choices', 0, 'finish_reason')
    answer, reasoning_text = separate_trace(message, finish_reason)
    if not answer.strip() and finish_reason != 'length':
        raise RuntimeError(f'{ep.model} returned no content (finish_reason {finish_reason})')
    return Reply(
        answer,
        reasoning_text,
        data.get('usage'),
        finish_reason,
        (time.perf_counter() - t0) * 1000,
        data.get('provider'),
        data.get('id'),
    )


def main() -> None:
    load_dotenv()
    endpoints = endpoints_from_env(os.environ)
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    labels: list[Labelled] = read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)
    selected = [label for label in labels if label['kind'] == SET]

    meta: EmbeddingsIndex = json.loads((DATA / 'embeddings.index.json').read_text(encoding='utf-8'))
    vectors = unpack_vectors((DATA / 'embeddings.bin').read_bytes(), meta['dim'], len(meta['ids']))
    qv: dict[str, list[float]] = json.loads((DATA / 'query-vectors.json').read_text(encoding='utf-8'))
    assert_dense_inputs_fresh(chunks, meta, [label['query'] for label in labels], qv)
    dense = DenseRetriever(meta['ids'], vectors, lambda q: qv[q])
    by_id = {c.id: c for c in chunks}

    done = done_keys(OUT)
    ran = missing_reasoning = truncated = 0
    for seed in SEEDS:
        for label in selected:
            context_ids = dense.search(label['query'], TOP_K)
            prompt = build_prompt(label['query'], [by_id[id] for id in context_ids])
            for ep in endpoints:
                if run_key(ep.model, label['query'], seed) in done:
                    continue
                reply = ask(prompt, ep, seed)
                reasoning_tokens = reasoning_tokens_of(reply.usage)
                if reasoning_tokens is None or (reasoning_tokens == 0 and reply.reasoning_text):
                    missing_reasoning += 1
                if reply.finish_reason == 'length':
                    truncated += 1
                row: Run = {
                    'query': label['query'],
                    'model': ep.model,
                    'seed': seed,
                    'answer': reply.answer,
                    'reasoningTokens': reasoning_tokens,
                    'reasoningChars': len(reply.reasoning_text),
                    'completionTokens': dig(reply.usage, 'completion_tokens'),
                    'promptTokens': dig(reply.usage, 'prompt_tokens'),
                    'latencyMs': reply.latency_ms,
                    'finishReason': reply.finish_reason,
                    'provider': reply.provider,
                    'generationId': reply.generation_id,
                    'contextIds': context_ids,
                }
                append_json_line(OUT, row)
                ran += 1
                cut = ' | USEKNUTO' if reply.finish_reason == 'length' else ''
                tokens = '—' if reasoning_tokens is None else reasoning_tokens
                chars = len(reply.reasoning_text)
                print(
                    f'{ran} [seed {seed}] {ep.model} | reasoning {tokens} tok / {chars} zn'
                    f' | completion {row["completionTokens"] or "—"}{cut}'
                )

    print(f'\nhotovo: {SET} set, seedy {",".join(map(str, SEEDS))}, {ran} běhů zapsáno do {OUT}')
    if missing_reasoning:
        print(f'POZOR: {missing_reasoning} odpovědí s nedůvěryhodným reasoning_tokens.')
        print('Použij reasoningChars; viz thinkingcap-preregistration.md, dodatek 3.')
    if truncated:
        print(f'POZOR: {truncated} odpovědí useknuto stropem {MAX_TOKENS} tokenů.')
        print('Ty otázky se ze srovnání vyřazují — viz dodatek 2, ne že by šetřily tokeny.')


if __name__ == '__main__':
    main()
