from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

Vectors = NDArray[np.float32]


def pack_vectors(vectors: Sequence[Sequence[float]], dim: int) -> bytes:
    flat = np.zeros((len(vectors), dim), dtype=np.float32)
    for i, v in enumerate(vectors):
        flat[i, : len(v)] = v
    return flat.tobytes()


def unpack_vectors(raw: bytes, dim: int, count: int) -> Vectors:
    return np.frombuffer(raw, dtype=np.float32, count=dim * count).reshape(count, dim)
