from lib.tokenize import tokenize

CASE_SUFFIXES: list[str] = [
    'atech',
    'etem',
    'atum',
    'ovech',
    'ovem',
    'ovmi',
    'ovi',
    'ove',
    'ovy',
    'ova',
    'ovo',
    'ych',
    'ymi',
    'ami',
    'ach',
    'ata',
    'aty',
    'emu',
    'eho',
    'imu',
    'ich',
    'emi',
    'ete',
    'eti',
    'iho',
    'imi',
    'ech',
    'em',
    'im',
    'um',
    'at',
    'am',
    'ou',
    'us',
    'os',
    'ys',
    'a',
    'e',
    'i',
    'o',
    'u',
    'y',
]

SORTED_SUFFIXES: list[str] = sorted(CASE_SUFFIXES, key=len, reverse=True)

POSSESSIVE_SUFFIXES: list[str] = ['ov', 'in', 'uv']

MIN_STEM: int = 4


def strip_first(word: str, suffixes: list[str]) -> str:
    for suffix in suffixes:
        if len(word) - len(suffix) >= MIN_STEM and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def stem(word: str) -> str:
    if len(word) <= MIN_STEM:
        return word

    out = strip_first(strip_first(word, SORTED_SUFFIXES), SORTED_SUFFIXES)
    return strip_first(out, POSSESSIVE_SUFFIXES)


def tokenize_stemmed(text: str) -> list[str]:
    return [stem(token) for token in tokenize(text)]
