import re
import unicodedata


def remove_diacritics(text: str) -> str:
    normalized = unicodedata.normalize('NFD', text)
    return ''.join(c for c in normalized if not unicodedata.combining(c))


def drop_short_tokens(tokens: list[str]) -> list[str]:
    kept: list[str] = []
    for token in tokens:
        if len(token) > 1:
            kept.append(token)
    return kept


def tokenize(text: str) -> list[str]:
    normalized_text = remove_diacritics(text)
    split_tokens = re.split(r'[^a-z0-9]+', normalized_text.lower())
    return drop_short_tokens(split_tokens)
