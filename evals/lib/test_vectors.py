import numpy as np

from lib.vectors import pack_vectors, unpack_vectors


def test_pack_then_unpack_round_trips_as_float32_rows() -> None:
    raw = pack_vectors([[1.0, 2.0, 3.0], [0.5, 0.25, 0.125]], 3)
    out = unpack_vectors(raw, 3, 2)
    assert out.shape == (2, 3)
    assert out.dtype == np.float32
    assert out.tolist() == [[1.0, 2.0, 3.0], [0.5, 0.25, 0.125]]


def test_packed_layout_is_the_typescript_one_little_endian_float32_row_major() -> None:
    assert pack_vectors([[1.0, -2.0]], 2) == b'\x00\x00\x80\x3f\x00\x00\x00\xc0'
