/**
 * Shared by precompute.ts (write) and run-retrieval.ts (read): a readFileSync Buffer can be
 * backed by Node's shared pool with a nonzero byteOffset, so the offset must survive the
 * Buffer->Float32Array reinterpretation. Kept in one place so both sides can't drift apart.
 */
export function packVectors(vectors: number[][], dim: number): Buffer {
  const flat = new Float32Array(vectors.length * dim)
  vectors.forEach((v, i) => flat.set(v, i * dim))
  return Buffer.from(flat.buffer)
}

export function unpackVectors(raw: Buffer, dim: number, count: number): Float32Array[] {
  const flat = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  return Array.from({ length: count }, (_, i) => flat.subarray(i * dim, (i + 1) * dim))
}
