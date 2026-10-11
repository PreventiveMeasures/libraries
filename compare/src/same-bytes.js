// Whether two byte arrays hold the same bytes, four at a time where both line
// up alike: two to three times as fast as byte by byte. Node has its own
// (same-bytes.node.js); indexedDB.cmp, which copies both first, is slower.

export function sameBytes(x, y) {
  const n = x.length
  if (n !== y.length) return false
  let i = 0
  if (n >= 32 && (x.byteOffset & 3) === (y.byteOffset & 3)) {
    for (const start = (4 - (x.byteOffset & 3)) & 3; i < start; i++) if (x[i] !== y[i]) return false
    const words = (n - i) >>> 2
    const a = new Int32Array(x.buffer, x.byteOffset + i, words), b = new Int32Array(y.buffer, y.byteOffset + i, words)
    for (let j = 0; j < words; j++) if (a[j] !== b[j]) return false
    i += words * 4
  }
  for (; i < n; i++) if (x[i] !== y[i]) return false
  return true
}
