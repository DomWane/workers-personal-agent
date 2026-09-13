import json
from pathlib import Path
from typing import Any


def read_json_lines(path: Path, *, required: bool = False) -> list[Any]:
    if not path.exists():
        if required:
            raise FileNotFoundError(f'missing input file: {path}')
        return []
    out: list[Any] = []
    for line in path.read_text(encoding='utf-8').split('\n'):
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def append_json_line(path: Path, record: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
