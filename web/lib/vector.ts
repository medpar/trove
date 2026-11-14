// Search vectors: unit-length embeddings quantized to int8 for storage in a Notion text property.

// Vectors are stored in Notion as int8 (512 bytes -> 684 base64 chars), plenty for ranking.
const PREFIX = 'v1:';

export function packVector(v: Float32Array): string {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127 * 4)));
  return PREFIX + Buffer.from(q.buffer).toString('base64');
}

export function unpackVector(s: string | null | undefined): Int8Array | null {
  if (!s?.startsWith(PREFIX)) return null;
  const b = Buffer.from(s.slice(PREFIX.length), 'base64');
  return b.length ? new Int8Array(b.buffer, b.byteOffset, b.length) : null;
}

/** Dot product of two packed vectors (they were unit length before quantizing, so this ranks like cosine). */
export function dot(a: Int8Array | Float32Array, b: Int8Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
