import os
from pathlib import Path

from lib.paths import EVALS_DIR

DOTENV = EVALS_DIR.parent / '.env'


def parse_dotenv(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip().removeprefix('export ').strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        out[key] = value
    return out


def load_dotenv(path: Path = DOTENV) -> None:
    if not path.exists():
        return
    for key, value in parse_dotenv(path.read_text(encoding='utf-8')).items():
        os.environ.setdefault(key, value)


def require_env(*names: str) -> list[str]:
    load_dotenv()
    values = [os.environ.get(name) for name in names]
    missing = [name for name, value in zip(names, values, strict=True) if not value]
    if missing:
        raise SystemExit(f'set {" and ".join(names)} in .env')
    return [value for value in values if value is not None]
