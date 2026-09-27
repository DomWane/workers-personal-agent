import pytest

from lib.snowball import tokenize_snowball


def s(word: str) -> str:
    return tokenize_snowball(word)[0]


@pytest.mark.parametrize(
    'group',
    [
        ['formulář', 'formuláře', 'formulářů', 'formuláři'],
        ['ruka', 'ruce', 'ruku'],
        ['otázky', 'otázek'],
    ],
)
def test_collapses_the_cases_of_one_noun_onto_one_stem(group: list[str]) -> None:
    assert len({s(word) for word in group}) == 1


def test_stems_before_folding_since_the_rules_read_the_diacritics() -> None:
    assert s('nových') == s('nový')
    assert s('čeština') != s('cesta')


def test_folds_diacritics_after_stemming() -> None:
    assert tokenize_snowball('kávu') == ['kav']


def test_lowercases() -> None:
    assert tokenize_snowball('KÁVU') == ['kav']


def test_splits_on_spaces_and_punctuation() -> None:
    assert tokenize_snowball('káva, cesta!') == ['kav', 'cest']


def test_splits_on_underscore_and_hyphen() -> None:
    assert tokenize_snowball('id_client-name') == ['id', 'client', 'nam']


def test_drops_one_char_tokens() -> None:
    assert tokenize_snowball('a bc d') == ['bc']


def test_keeps_digits() -> None:
    assert tokenize_snowball('r2 123456') == ['r2', '123456']


def test_drops_non_latin_script() -> None:
    assert tokenize_snowball('čeština 中文') == ['cesk']


def test_empty_input() -> None:
    assert tokenize_snowball('') == []


def test_stems_the_query_the_same_way_as_the_index() -> None:
    assert s('schémata') in tokenize_snowball('Která schémata se lišila?')
