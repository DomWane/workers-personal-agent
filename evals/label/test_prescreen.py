from label.prescreen import flags_for, reply_of
from lib.corpus import Chunk

LONG = 'a' * 400


def mk(text: str, ts: str = 't') -> Chunk:
    return Chunk(id='c', text=text, session='s', ts=ts, project='p')


def test_flags_a_reply_that_only_plans() -> None:
    assert 'scaffolding' in flags_for(mk(f'otázka\n\nLet me first look at the code. {LONG}'))


def test_does_not_flag_a_reply_that_plans_and_then_concludes() -> None:
    assert 'scaffolding' not in flags_for(
        mk(f'otázka\n\nLet me check. The root cause is a late webhook. {LONG}')
    )


def test_flags_a_completion_notice() -> None:
    assert 'status' in flags_for(mk('otázka\n\nHotovo, nasazeno.'))


def test_leaves_an_ordinary_informative_chunk_unflagged() -> None:
    assert (
        flags_for(mk(f'Jak funguje cache invalidace?\n\nCache se invaliduje přes tag purge, protože {LONG}'))
        == []
    )


def test_reply_of_takes_everything_after_the_prompt_half() -> None:
    assert reply_of('prompt\n\nodpověď\n\npokračování') == 'odpověď\n\npokračování'


SOURCED = 'kdo to je?\n\nJe to výzkumník a spoluzakladatel.\n\nZdroje: web_search (example.com, Crunchbase)'


def test_marks_a_sourced_claim_from_before_the_search_fix_as_a_documented_fabrication() -> None:
    assert 'fabricated-era' in flags_for(mk(SOURCED, '2026-07-29T09:29:00Z'))


def test_still_asks_for_verification_of_a_sourced_claim_made_after_the_fix() -> None:
    flags = flags_for(mk(SOURCED, '2026-07-30T09:00:00Z'))
    assert 'sourced' in flags
    assert 'fabricated-era' not in flags


def test_leaves_a_chunk_about_the_authors_own_code_alone() -> None:
    assert (
        flags_for(
            mk(f'proč to padá?\n\nRoot cause je pozdní webhook, protože {LONG}', '2026-07-01T00:00:00Z')
        )
        == []
    )


def test_does_not_flag_a_czech_plan_followed_by_an_english_conclusion() -> None:
    text = f'kam dam klice\n\nOvěřím konvenci. The pattern is clear now: secrets live on the store. {LONG}'
    assert 'scaffolding' not in flags_for(mk(text))


def test_still_flags_a_plan_that_never_lands() -> None:
    assert 'scaffolding' in flags_for(mk(f'otázka\n\nOvěřím konvenci a pak se ozvu. {LONG}'))
