import json
import math
from pathlib import Path

import pytest

from lib.corpus import Chunk
from models.analyze import bootstrap_median, first_per_pair, median, repeat_spreads, wilson
from models.compare import (
    Run,
    build_prompt,
    done_keys,
    reasoning_text_of,
    reasoning_tokens_of,
    run_key,
    separate_trace,
    split_thinking,
)
from models.judge import build_pairs
from models.judge_agreement import cohen_kappa, collapse_orders
from models.llm_judge import LlmVerdict, parse_verdict


def chunk(id: str, text: str) -> Chunk:
    return Chunk(id=id, text=text, session='s', ts='2026-07-01T00:00:00Z', project='p')


def run(query: str, model: str, chars: int = 10, answer: str | None = None) -> Run:
    return {
        'query': query,
        'model': model,
        'seed': 1,
        'answer': f'odpověď od {model}' if answer is None else answer,
        'reasoningTokens': 1,
        'reasoningChars': chars,
        'completionTokens': 2,
        'promptTokens': 3,
        'latencyMs': 4,
        'finishReason': 'stop',
        'provider': None,
        'generationId': None,
        'contextIds': [],
    }


def test_reasoning_tokens_reads_both_shapes_providers_use() -> None:
    assert reasoning_tokens_of({'completion_tokens_details': {'reasoning_tokens': 120}}) == 120
    assert reasoning_tokens_of({'reasoning_tokens': 90}) == 90


def test_reasoning_tokens_returns_none_when_the_field_is_absent_never_zero() -> None:
    assert reasoning_tokens_of({'completion_tokens': 50}) is None
    assert reasoning_tokens_of(None) is None


def test_reasoning_text_reads_the_trace_under_either_provider_name() -> None:
    assert reasoning_text_of({'reasoning': 'uvažuji'}) == 'uvažuji'
    assert reasoning_text_of({'reasoning_content': 'uvažuji'}) == 'uvažuji'


def test_reasoning_text_gives_the_trace_when_the_count_says_zero() -> None:
    assert reasoning_tokens_of({'completion_tokens_details': {'reasoning_tokens': 0}}) == 0
    assert len(reasoning_text_of({'reasoning_content': 'dlouhá úvaha'})) > 0


def test_reasoning_text_is_empty_when_the_model_returned_no_trace_at_all() -> None:
    assert reasoning_text_of({}) == ''
    assert reasoning_text_of(None) == ''


def test_split_separates_the_trace_a_raw_vllm_server_leaves_inline() -> None:
    assert split_thinking('<think>rozmýšlím se</think>\n\nOdpověď je 42.') == (
        'Odpověď je 42.',
        'rozmýšlím se',
    )


def test_split_leaves_content_untouched_when_the_provider_already_split_the_trace_out() -> None:
    assert split_thinking('Odpověď je 42.') == ('Odpověď je 42.', '')


def test_split_treats_an_unclosed_tag_as_all_trace_which_is_what_hitting_the_ceiling_looks_like() -> None:
    answer, thinking = split_thinking('<think>pořád ještě přemýšlím a nedošel jsem')
    assert answer == ''
    assert thinking == 'pořád ještě přemýšlím a nedošel jsem'


def test_split_treats_a_lone_closing_tag_as_the_end_of_the_trace() -> None:
    assert split_thinking('rozmýšlím se\n</think>\n\nOdpověď je 42.') == ('Odpověď je 42.', 'rozmýšlím se')


def test_split_counts_every_block_when_a_model_opens_the_tag_more_than_once() -> None:
    assert split_thinking('<think>první</think>mezitím<think>druhá</think>konec') == (
        'mezitímkonec',
        'první\ndruhá',
    )


def test_separate_prefers_the_provider_field_when_there_is_one() -> None:
    assert separate_trace({'content': 'Odpověď.', 'reasoning_content': 'úvaha'}, 'stop') == (
        'Odpověď.',
        'úvaha',
    )


def test_separate_falls_back_to_the_inline_block_when_there_is_not() -> None:
    assert separate_trace({'content': 'úvaha\n</think>\nOdpověď.'}, 'stop') == ('Odpověď.', 'úvaha')


def test_separate_reads_a_tagless_completion_cut_off_by_the_ceiling_as_all_trace_never_as_an_answer() -> None:
    assert separate_trace({'content': 'pořád ještě zvažuji, jestli'}, 'length') == (
        '',
        'pořád ještě zvažuji, jestli',
    )


def test_separate_still_trusts_a_tagless_completion_that_stopped_normally() -> None:
    assert separate_trace({'content': 'Odpověď je 42.'}, 'stop') == ('Odpověď je 42.', '')


def test_build_prompt_gives_both_models_byte_identical_input() -> None:
    ctx = [chunk('a', 'první'), chunk('b', 'druhý')]
    assert build_prompt('proč?', ctx) == build_prompt('proč?', ctx)
    assert 'OTÁZKA: proč?' in build_prompt('proč?', ctx)


def test_done_keys_has_nothing_to_resume_from_before_the_first_run(tmp_path: Path) -> None:
    assert done_keys(tmp_path / 'missing.jsonl') == set()


def test_done_keys_produces_keys_the_caller_can_actually_look_up(tmp_path: Path) -> None:
    path = tmp_path / 'model-runs-test.jsonl'
    path.write_text(json.dumps(run('proč to spadlo?', 'base')) + '\n')
    assert run_key('base', 'proč to spadlo?', 1) in done_keys(path)


def test_run_key_keys_on_the_model_and_query_pair_and_on_the_seed() -> None:
    assert run_key('base', 'q') != run_key('tuned', 'q')
    assert run_key('base', 'q', 1) != run_key('base', 'q', 2)


RUNS = [run('q1', 'base'), run('q1', 'tuned'), run('q2', 'base'), run('q2', 'tuned')]


def test_pairs_randomise_sides_so_a_position_preference_cannot_read_as_a_model_preference() -> None:
    assert [p.left_is_first_model for p in build_pairs(RUNS)] != [True, True]


def test_pairs_are_deterministic_so_a_resumed_session_shows_the_same_sides() -> None:
    assert build_pairs(RUNS) == build_pairs(RUNS)


def test_pairs_skip_a_question_only_one_model_answered_rather_than_scoring_it_against_nothing() -> None:
    assert build_pairs([run('q1', 'base')]) == []


def test_pairs_judge_a_question_once_even_when_a_run_was_recorded_twice() -> None:
    assert len(build_pairs([run('q1', 'base'), run('q1', 'base'), run('q1', 'tuned')])) == 1


def test_pairs_skip_a_pair_where_one_side_hit_the_ceiling_and_returned_nothing() -> None:
    empty: Run = {**run('q1', 'base'), 'answer': '', 'finishReason': 'length'}
    assert build_pairs([empty, run('q1', 'tuned')]) == []


def test_kappa_is_1_when_the_two_judges_never_disagree() -> None:
    assert cohen_kappa(['a', 'b', 'tie'], ['a', 'b', 'tie']) == pytest.approx(1)


def test_kappa_is_near_0_for_a_judge_that_agrees_only_as_often_as_chance_would() -> None:
    assert cohen_kappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']) == pytest.approx(0)


def test_kappa_does_not_reward_a_judge_that_always_says_the_same_thing() -> None:
    human = ['tie', 'tie', 'tie', 'a', 'b']
    assert cohen_kappa(human, ['tie'] * 5) == pytest.approx(0)


def verdict(query: str, first_shown: str, winner: str) -> LlmVerdict:
    return {'query': query, 'firstShown': first_shown, 'winner': winner, 'raw': winner}


def test_collapse_keeps_a_verdict_the_judge_gave_in_both_presentations() -> None:
    assert collapse_orders([verdict('q', 'base', 'base'), verdict('q', 'tuned', 'base')])['q'] == 'base'


def test_collapse_calls_it_a_tie_when_swapping_the_sides_swaps_the_winner() -> None:
    assert collapse_orders([verdict('q', 'base', 'base'), verdict('q', 'tuned', 'tuned')])['q'] == 'tie'


def test_parse_verdict_reads_the_last_line_and_falls_back_to_tie() -> None:
    first, second = run('q', 'base'), run('q', 'tuned')
    assert parse_verdict('Uvažuji...\nB.', first, second) == 'tuned'
    assert parse_verdict('A', first, second) == 'base'
    assert parse_verdict('nevím', first, second) == 'tie'


def test_median_averages_the_middle_two_on_an_even_count() -> None:
    assert median([1, 2, 3, 4]) == 2.5
    assert median([3, 1, 2]) == 2


def test_first_per_pair_keeps_the_first_run_per_model_and_question() -> None:
    runs = [run('q', 'base', 100), run('q', 'base', 500), run('q', 'tuned', 50)]
    assert [r['reasoningChars'] for r in first_per_pair(runs)] == [100, 50]


def test_repeat_spreads_measure_one_model_against_itself_on_identical_input() -> None:
    assert repeat_spreads([run('q', 'base', 100), run('q', 'base', 50), run('q', 'tuned', 80)]) == [0.5]


def test_repeat_spreads_are_empty_when_nothing_was_run_twice() -> None:
    assert repeat_spreads([run('q', 'base', 100)]) == []


def test_bootstrap_median_is_deterministic_so_a_reported_interval_can_be_reproduced() -> None:
    v = [0.1, 0.3, 0.5, 0.2, 0.4]
    assert bootstrap_median(v, 7, 500) == bootstrap_median(v, 7, 500)


def test_bootstrap_median_brackets_the_sample_median() -> None:
    v = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    lo, hi = bootstrap_median(v, 7, 2000)
    assert lo <= median(v) <= hi


def test_bootstrap_median_reproduces_the_typescript_interval() -> None:
    assert bootstrap_median([0.1, 0.3, 0.5, 0.2, 0.4], 7, 500) == (0.1, 0.5)


def test_wilson_stays_inside_0_1_where_the_normal_approximation_would_not() -> None:
    lo, hi = wilson(12, 12)
    assert lo > 0
    assert hi <= 1


def test_wilson_brackets_a_half_and_half_split_symmetrically_around_0_5() -> None:
    lo, hi = wilson(10, 20)
    assert (lo + hi) / 2 == pytest.approx(0.5, abs=1e-10)


def test_wilson_and_bootstrap_are_nan_on_empty_input() -> None:
    assert all(math.isnan(x) for x in wilson(0, 0))
    assert all(math.isnan(x) for x in bootstrap_median([]))
