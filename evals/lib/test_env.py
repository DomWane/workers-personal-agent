import os
from pathlib import Path

from lib.env import load_dotenv, parse_dotenv


def test_parses_assignments_and_ignores_comments_and_blanks() -> None:
    text = '# secrets\n\nCF_ACCOUNT_ID=abc123\nexport JUDGE_MODEL="deepseek/x"\nKEY=\'quoted value\'\n'
    assert parse_dotenv(text) == {
        'CF_ACCOUNT_ID': 'abc123',
        'JUDGE_MODEL': 'deepseek/x',
        'KEY': 'quoted value',
    }


def test_load_never_overrides_a_variable_already_in_the_environment(tmp_path: Path) -> None:
    p = tmp_path / '.env'
    p.write_text('EVAL_TEST_VAR=from-file\n')
    os.environ['EVAL_TEST_VAR'] = 'from-shell'
    try:
        load_dotenv(p)
        assert os.environ['EVAL_TEST_VAR'] == 'from-shell'
    finally:
        del os.environ['EVAL_TEST_VAR']


def test_load_tolerates_a_missing_file(tmp_path: Path) -> None:
    load_dotenv(tmp_path / 'nope')
