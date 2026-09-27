import re

import Stemmer

from lib.tokenize import drop_short_tokens, remove_diacritics

STEMMER = Stemmer.Stemmer('czech')

WORD_BOUNDARY = re.compile(r'[\W_]+')
ASCII_TOKEN = re.compile(r'[a-z0-9]+')


def tokenize_snowball(text: str) -> list[str]:
    words = WORD_BOUNDARY.split(text.lower())
    folded = [remove_diacritics(stem) for stem in STEMMER.stemWords(words)]
    return drop_short_tokens([token for token in folded if ASCII_TOKEN.fullmatch(token)])
