import pytest

from lib.corpus import Chunk


def mk(id: str, text: str) -> Chunk:
    return Chunk(id=id, text=text, session='s', ts='t', project='p')


@pytest.fixture
def corpus() -> list[Chunk]:
    return [
        mk('c1', 'Cache invalidace na Cloudflare Workers přes tag purge'),
        mk('c2', 'Workers KV je eventually consistent, čtení je rychlé'),
        mk('c3', 'Telegram bot odpovídá na zprávy pomocí webhooku'),
        mk('c4', 'Nákupní seznam: mléko, chléb, káva'),
    ]
