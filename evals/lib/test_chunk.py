import pytest

from lib.chunk import ChunkConfig, Piece, chunk_config_from_env, expand_chunks, parent_of, split_text


def test_split_returns_the_text_whole_when_it_fits() -> None:
    assert split_text('short', ChunkConfig(chars=10, overlap=2)) == ['short']


def test_split_slides_by_chars_minus_overlap_so_every_cut_appears_whole_in_one_neighbour() -> None:
    assert split_text('abcdefghijkl', ChunkConfig(chars=5, overlap=2)) == ['abcde', 'defgh', 'ghijk', 'jkl']


def test_split_covers_the_whole_text() -> None:
    text = 'x' * 4000
    parts = split_text(text, ChunkConfig(chars=1600, overlap=200))
    assert len(''.join(parts)) >= len(text)
    assert parts[-1] == text[-(len(text) - 2800) :]


def test_split_does_not_emit_a_trailing_chunk_that_is_pure_overlap() -> None:
    assert split_text('abcdefgh', ChunkConfig(chars=4, overlap=2)) == ['abcd', 'cdef', 'efgh']


def test_config_is_absent_by_default_so_the_unchunked_baseline_is_untouched() -> None:
    assert chunk_config_from_env({}) is None


def test_config_defaults_the_overlap_but_never_the_size() -> None:
    assert chunk_config_from_env({'EVAL_CHUNK_CHARS': '1600'}) == ChunkConfig(chars=1600, overlap=200)


def test_config_refuses_an_overlap_that_would_not_advance() -> None:
    with pytest.raises(ValueError, match='EVAL_CHUNK_OVERLAP'):
        chunk_config_from_env({'EVAL_CHUNK_CHARS': '400', 'EVAL_CHUNK_OVERLAP': '400'})


CORPUS = [Piece('aaaa', 'x' * 9), Piece('bbbb', 'fits')]


def test_expand_is_the_identity_without_a_config() -> None:
    assert expand_chunks(CORPUS, None) is CORPUS


def test_expand_suffixes_ord_and_keeps_corpus_order() -> None:
    out = expand_chunks(CORPUS, ChunkConfig(chars=4, overlap=1))
    assert [c.id for c in out] == ['aaaa#0', 'aaaa#1', 'aaaa#2', 'bbbb#0']


def test_parent_of_strips_the_ord() -> None:
    assert parent_of('aaaa#3') == 'aaaa'


def test_parent_of_leaves_an_unchunked_id_alone() -> None:
    assert parent_of('aaaa') == 'aaaa'
