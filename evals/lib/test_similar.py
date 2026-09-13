from lib.corpus import Chunk
from lib.similar import Neighbour, neighbours_of, pick_neighbours, similarity


def mk(id: str, text: str) -> Chunk:
    return Chunk(id=id, text=text, session='s', ts='t', project='p')


def test_similarity_is_1_for_identical_sets_0_for_disjoint_0_for_empty() -> None:
    assert similarity({'a', 'b'}, {'a', 'b'}) == 1
    assert similarity({'a'}, {'b'}) == 0
    assert similarity(set(), {'a'}) == 0


TARGET = mk('t', 'cache invalidace přes tag purge na Cloudflare Workers')
CORPUS = [
    TARGET,
    mk('near', 'cache invalidace na Cloudflare Workers přes purge tagu'),
    mk('far', 'nákupní seznam mléko chléb káva'),
]


def test_ranks_the_topically_close_chunk_first_and_excludes_the_target() -> None:
    out = neighbours_of(TARGET, CORPUS)
    assert 't' not in [n.chunk.id for n in out]
    assert out[0].chunk.id == 'near'


def test_drops_chunks_sharing_nothing_rather_than_padding_the_list() -> None:
    assert 'far' not in [n.chunk.id for n in neighbours_of(TARGET, CORPUS)]


NS = [Neighbour(mk('a', 'x'), 0.3), Neighbour(mk('b', 'y'), 0.2)]


def test_maps_typed_numbers_to_chunk_ids() -> None:
    assert pick_neighbours('1,2', NS) == ['a', 'b']


def test_ignores_blanks_and_out_of_range_input_rather_than_guessing() -> None:
    assert pick_neighbours('', NS) == []
    assert pick_neighbours('3, x, 0', NS) == []
