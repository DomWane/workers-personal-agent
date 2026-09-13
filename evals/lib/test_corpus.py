from dataclasses import dataclass

from lib.corpus import Chunk, corpus_text_hash


@dataclass(frozen=True)
class Text:
    text: str


def c(text: str) -> Text:
    return Text(text)


def test_hash_is_stable_for_the_same_texts_in_the_same_order() -> None:
    assert corpus_text_hash([c('a'), c('b')]) == corpus_text_hash([c('a'), c('b')])


def test_hash_changes_when_any_chunk_text_changes() -> None:
    assert corpus_text_hash([c('a'), c('b')]) != corpus_text_hash([c('a'), c('b!')])


def test_hash_changes_when_the_order_changes_because_embeddings_bin_is_positional() -> None:
    assert corpus_text_hash([c('a'), c('b')]) != corpus_text_hash([c('b'), c('a')])


def test_hash_cannot_be_collided_by_moving_the_boundary_between_two_chunks() -> None:
    assert corpus_text_hash([c('ab'), c('c')]) != corpus_text_hash([c('a'), c('bc')])


def test_hash_covers_the_text_and_nothing_else() -> None:
    with_meta = [Chunk(id='s:0', text='a', session='s', ts='t', project='p')]
    assert corpus_text_hash(with_meta) == corpus_text_hash([c('a')])


def test_hash_matches_the_typescript_writer_so_existing_index_files_stay_valid() -> None:
    assert corpus_text_hash([c('káva'), c('b')]) == (
        '5395c6ef3bd9d6c3cb3ea3002568b2967b845fa87f8fa58fbdd3d4507dfe789c'
    )
