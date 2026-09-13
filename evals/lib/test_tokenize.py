from lib.tokenize import tokenize


def test_folds_diacritics() -> None:
    assert tokenize('káva') == ['kava']


def test_folded_and_unfolded_spelling_tokenize_the_same() -> None:
    assert tokenize('káva') == tokenize('kava')


def test_lowercases() -> None:
    assert tokenize('KAVA') == ['kava']


def test_splits_on_spaces() -> None:
    assert tokenize('hello world') == ['hello', 'world']


def test_splits_on_punctuation() -> None:
    assert tokenize('hello,world!') == ['hello', 'world']


def test_splits_on_underscore_and_hyphen() -> None:
    assert tokenize('id_client-name') == ['id', 'client', 'name']


def test_drops_one_char_tokens() -> None:
    assert tokenize('a bc d') == ['bc']


def test_keeps_digits() -> None:
    assert tokenize('123456') == ['123456']


def test_drops_non_latin_script() -> None:
    assert tokenize('čínština 中文') == ['cinstina']


def test_empty_input() -> None:
    assert tokenize('') == []
