from embed.fasttext_extract import corpus_vocabulary, fold_word
from lib.corpus import Chunk


def test_vocabulary_is_the_tokenizer_view_of_corpus_and_queries() -> None:
    chunks = [Chunk(id='a', text='Cache invalidace přes tag', session='s', ts='t', project='p')]
    assert corpus_vocabulary(chunks, ['Jak purgnout?']) == {
        'cache',
        'invalidace',
        'pres',
        'tag',
        'jak',
        'purgnout',
    }


def test_fold_word_matches_the_tokenizer_folding_so_lookups_hit() -> None:
    assert fold_word('Účet') == 'ucet'
