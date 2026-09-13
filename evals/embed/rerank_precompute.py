import hashlib
import json
import os
from typing import NamedTuple

from lib.corpus import CORPUS, Chunk, EmbeddingsIndex
from lib.env import require_env
from lib.http import dig, post_json
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from lib.stem import tokenize_stemmed
from lib.vectors import unpack_vectors
from retrievers.bm25 import BM25Retriever
from retrievers.dense import DenseRetriever
from retrievers.rerank import RerankRow

OUT = DATA / os.environ.get('EVAL_RERANK_OUT', 'rerank.jsonl')
MODEL = '@cf/baai/bge-reranker-base'
DEPTH = int(os.environ.get('EVAL_RERANK_DEPTH', '20'))
MAX_CHARS = int(os.environ.get('EVAL_RERANK_MAX_CHARS', '1600'))


def candidate_hash(ids: list[str]) -> str:
    return hashlib.sha256('\n'.join(ids).encode('utf-8')).hexdigest()[:16]


def candidates_for(dense: list[str], lexical: list[str]) -> list[str]:
    return list(dict.fromkeys([*dense, *lexical]))


class Scored(NamedTuple):
    position: int
    score: float


def rerank(query: str, texts: list[str], account: str, token: str) -> list[Scored]:
    data = post_json(
        f'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}',
        {'query': query, 'contexts': [{'text': t[:MAX_CHARS]} for t in texts], 'top_k': len(texts)},
        token,
    )
    out: list[dict[str, float]] | None = dig(data, 'result', 'response')
    if not out or len(out) != len(texts):
        raise RuntimeError(f'{MODEL} returned {len(out or [])} scores for {len(texts)} contexts')
    return [Scored(int(r['id']), float(r['score'])) for r in out]


def main() -> None:
    account, token = require_env('CF_ACCOUNT_ID', 'CF_API_TOKEN')
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    labels = read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)
    meta: EmbeddingsIndex = json.loads((DATA / 'embeddings.index.json').read_text(encoding='utf-8'))
    vectors = unpack_vectors((DATA / 'embeddings.bin').read_bytes(), meta['dim'], len(meta['ids']))
    qv: dict[str, list[float]] = json.loads((DATA / 'query-vectors.json').read_text(encoding='utf-8'))

    dense = DenseRetriever(meta['ids'], vectors, lambda q: qv[q])
    lexical = BM25Retriever(chunks, name='bm25-stem', tokenizer=tokenize_stemmed)
    by_id = {c.id: c for c in chunks}
    done: dict[str, RerankRow] = {r['query']: r for r in read_json_lines(OUT)}
    ran = 0

    for label in labels:
        query: str = label['query']
        ids = candidates_for(dense.search(query, DEPTH), lexical.search(query, DEPTH))
        digest = candidate_hash(ids)
        prev = done.get(query)
        if (
            prev
            and prev['candidateHash'] == digest
            and prev['depth'] == DEPTH
            and prev['maxChars'] == MAX_CHARS
        ):
            continue
        scored = sorted(rerank(query, [by_id[id].text for id in ids], account, token), key=lambda s: -s.score)
        row: RerankRow = {
            'query': query,
            'candidateHash': digest,
            'ranked': [ids[s.position] for s in scored],
            'scores': [s.score for s in scored],
            'depth': DEPTH,
            'maxChars': MAX_CHARS,
        }
        append_json_line(OUT, row)
        ran += 1
        print(f'{ran} {query[:50]} | {len(ids)} kandidátů')

    print(f'\nhotovo: {ran} dotazů přeuspořádáno, {len(labels) - ran} beze změny')


if __name__ == '__main__':
    main()
