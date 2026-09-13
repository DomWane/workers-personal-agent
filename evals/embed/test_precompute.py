from pathlib import Path

import numpy as np

from embed.precompute import can_reuse_corpus_vectors, queries_to_embed
from lib.chunk import Piece
from lib.corpus import EmbeddingsIndex, corpus_text_hash
from lib.vectors import pack_vectors, unpack_vectors

CHUNKS = [Piece('s:0', 'první text'), Piece('s:1', 'druhý text')]
META: EmbeddingsIndex = {'dim': 3, 'ids': ['s:0', 's:1'], 'textHash': corpus_text_hash(CHUNKS)}


def test_reuses_when_the_stored_ids_and_chunk_texts_both_match() -> None:
    assert can_reuse_corpus_vectors(CHUNKS, {**META, 'maxChars': 1600}, 1600)


def test_re_embeds_when_the_truncation_limit_changed_which_leaves_the_corpus_text_identical() -> None:
    assert not can_reuse_corpus_vectors(CHUNKS, {**META, 'maxChars': 1600}, 3200)


def test_re_embeds_an_index_written_before_the_limit_was_recorded() -> None:
    assert not can_reuse_corpus_vectors(CHUNKS, META, 1600)


def test_re_embeds_when_there_is_nothing_stored() -> None:
    assert not can_reuse_corpus_vectors(CHUNKS, None)


def test_re_embeds_when_a_re_ingest_changed_the_chunk_count() -> None:
    assert not can_reuse_corpus_vectors([*CHUNKS, Piece('s:2', 'třetí')], META)


def test_re_embeds_when_the_ids_match_as_a_set_but_not_positionally() -> None:
    assert not can_reuse_corpus_vectors([CHUNKS[1], CHUNKS[0]], META)


def test_re_embeds_when_the_chunk_text_changed_under_unchanged_ids() -> None:
    rewritten = [Piece('s:0', 'první text'), Piece('s:1', 'druhý text, jinak')]
    assert not can_reuse_corpus_vectors(rewritten, META)


def test_re_embeds_when_the_stored_index_predates_the_text_hash() -> None:
    assert not can_reuse_corpus_vectors(CHUNKS, {'dim': 3, 'ids': ['s:0', 's:1']})


def test_only_pays_for_queries_with_no_usable_vector() -> None:
    assert queries_to_embed(['known', 'hard'], {'known': [1.0, 2.0, 3.0]}, 3) == ['hard']


def test_re_embeds_a_stored_vector_of_the_wrong_dimension() -> None:
    assert queries_to_embed(['q'], {'q': [1.0, 2.0]}, 3) == ['q']


def test_charges_once_for_a_query_that_appears_in_the_labels_twice() -> None:
    assert queries_to_embed(['dup', 'dup'], {}, 3) == ['dup']


def test_embeddings_bin_round_trip_recovers_the_exact_vectors_written_in_order(tmp_path: Path) -> None:
    dim = 4
    vectors = [[1.0, 2.0, 3.0, 4.0], [-1.5, 0.0, 100.25, -0.001], [0.0, 0.0, 0.0, 0.0]]
    bin_path = tmp_path / 'embeddings.bin'
    bin_path.write_bytes(pack_vectors(vectors, dim))
    rebuilt = unpack_vectors(bin_path.read_bytes(), dim, len(vectors))
    assert rebuilt.shape == (3, 4)
    assert rebuilt.tolist() == np.array(vectors, dtype=np.float32).tolist()
