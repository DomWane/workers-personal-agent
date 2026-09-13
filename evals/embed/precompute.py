import json
import os
from collections.abc import Mapping, Sequence

from lib.chunk import HasIdText, chunk_config_from_env, expand_chunks
from lib.corpus import CORPUS, Chunk, EmbeddingsIndex, corpus_text_hash
from lib.env import require_env
from lib.http import dig, post_json
from lib.jsonl import read_json_lines
from lib.paths import DATA
from lib.vectors import pack_vectors

MAX_CHARS = int(os.environ.get('EVAL_EMBED_MAX_CHARS', '1600'))
BATCH = 25
BIN = DATA / 'embeddings.bin'
INDEX = DATA / 'embeddings.index.json'
QUERY_VECTORS = DATA / 'query-vectors.json'
MODEL = '@cf/baai/bge-m3'


def can_reuse_corpus_vectors(
    chunks: Sequence[HasIdText], meta: EmbeddingsIndex | None, max_chars: int = MAX_CHARS
) -> bool:
    if meta is None or meta['dim'] <= 0 or len(meta['ids']) != len(chunks):
        return False
    if meta.get('maxChars') != max_chars:
        return False
    if any(id != c.id for id, c in zip(meta['ids'], chunks, strict=True)):
        return False
    text_hash = meta.get('textHash')
    return bool(text_hash) and text_hash == corpus_text_hash(chunks)


def queries_to_embed(queries: list[str], existing: Mapping[str, Sequence[float]], dim: int) -> list[str]:
    return [q for q in dict.fromkeys(queries) if len(existing.get(q, ())) != dim]


def embed_batch(texts: list[str], account: str, token: str) -> list[list[float]]:
    data = post_json(
        f'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}',
        {'text': [t[:MAX_CHARS] for t in texts], 'truncate_inputs': True},
        token,
    )
    out: list[list[float]] | None = dig(data, 'result', 'data')
    if not out or len(out) != len(texts):
        raise RuntimeError('workers-ai returned a short batch')
    dim = len(out[0])
    for i, v in enumerate(out):
        if len(v) != dim:
            raise RuntimeError(f'workers-ai vector {i} has dim {len(v)}, expected {dim}')
    return out


def main() -> None:
    account, token = require_env('CF_ACCOUNT_ID', 'CF_API_TOKEN')
    cfg = chunk_config_from_env()
    corpus = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    chunks = expand_chunks(corpus, cfg)
    ids = [c.id for c in chunks]
    if cfg:
        print(f'chunking {len(corpus)} corpus entries into {len(chunks)} at {cfg.chars}/{cfg.overlap}')

    meta: EmbeddingsIndex | None = (
        json.loads(INDEX.read_text(encoding='utf-8')) if BIN.exists() and INDEX.exists() else None
    )
    if meta and can_reuse_corpus_vectors(chunks, meta):
        dim = meta['dim']
        print(f'reusing {len(meta["ids"])} corpus vectors from {BIN} (dim {dim}, texts unchanged)')
        print('embedding queries only')
    else:
        print(f're-embedding all {len(chunks)} corpus chunks (no {BIN} matching these ids and texts)')
        vectors: list[list[float]] = []
        for i in range(0, len(chunks), BATCH):
            batch = chunks[i : i + BATCH]
            vectors.extend(embed_batch([c.text for c in batch], account, token))
            print(f'{min(i + BATCH, len(chunks))}/{len(chunks)}')
        dim = len(vectors[0]) if vectors else 0
        BIN.write_bytes(pack_vectors(vectors, dim))
        index: EmbeddingsIndex = {
            'dim': dim,
            'ids': ids,
            'textHash': corpus_text_hash(chunks),
            'maxChars': MAX_CHARS,
        }
        if cfg:
            index['chunkChars'] = cfg.chars
            index['chunkOverlap'] = cfg.overlap
        INDEX.write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
        print(f'embedded {len(vectors)} chunks, dim {dim}')

    queries = [row['query'] for row in read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)]
    qv: dict[str, list[float]] = (
        json.loads(QUERY_VECTORS.read_text(encoding='utf-8')) if QUERY_VECTORS.exists() else {}
    )
    unique = len(set(queries))
    todo = queries_to_embed(queries, qv, dim)
    print(f'queries: {len(todo)} to embed, {unique - len(todo)} of {unique} reused')
    for i in range(0, len(todo), BATCH):
        batch = todo[i : i + BATCH]
        for q, vec in zip(batch, embed_batch(batch, account, token), strict=True):
            qv[q] = vec
        QUERY_VECTORS.write_text(json.dumps(qv, ensure_ascii=False) + '\n', encoding='utf-8')
    QUERY_VECTORS.write_text(json.dumps(qv, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
