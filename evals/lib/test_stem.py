import pytest

from lib.stem import stem, tokenize_stemmed
from lib.tokenize import tokenize


def s(word: str) -> str:
    return stem(tokenize(word)[0])


@pytest.mark.parametrize(
    'group',
    [
        ['formulář', 'formuláře', 'formulářů', 'formuláři'],
        ['zahrada', 'zahrady', 'zahradu', 'zahradě'],
        ['učitel', 'učitele', 'učitelovi', 'učitelech'],
        ['schéma', 'schémata', 'schémat', 'schématu'],
    ],
)
def test_collapses_the_cases_of_one_noun_onto_one_stem(group: list[str]) -> None:
    assert len({s(word) for word in group}) == 1


def test_does_not_invent_a_consonant_which_a_blind_palatalisation_rule_did() -> None:
    assert s('ulice') == 'ulic'
    assert s('garáže') == 'garaz'


@pytest.mark.parametrize('word', ['vs', 'api', 'r2', 'json'])
def test_leaves_short_tokens_alone_since_their_ending_is_a_name_rather_than_grammar(word: str) -> None:
    assert s(word) == tokenize(word)[0]


def test_keeps_unrelated_words_apart() -> None:
    assert s('stavba') != s('stav')
    assert s('ruka') != s('růže')


def test_stems_the_query_the_same_way_as_the_index() -> None:
    assert s('schéma') in tokenize_stemmed('Která schémata se lišila?')
