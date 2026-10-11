// git's rename score (diffcore-delta.c, estimate_similarity in diffcore-rename.c,
// git >= 2.44), bit for bit since it decides which renames git finds: bytes of
// the new file in spans the old file has too, over the larger file's size.

// Scores are out of 60000; 50% is 30000.
export const MAX_SCORE = 60000

const HASHBASE = 107927

// git's binary test, used here only to decide whether a CR before an LF counts.
const looksBinary = (data) => data.subarray(0, 8000).includes(0)

const spanHash = (accum1, accum2) => ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE

// Bytes per span hash, a span ending at an LF or after 64 bytes; sorted by
// hash, as git keeps them, so two files compare in one walk down both.
export function spanCounts(data) {
  const text = !looksBinary(data)
  const counts = new Map()
  const add = (hash, n) => counts.set(hash, (counts.get(hash) ?? 0) + n)
  let accum1 = 0, accum2 = 0, n = 0
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (text && c === 0x0D && data[i + 1] === 0x0A) continue
    const old1 = accum1
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0
    if (++n < 64 && c !== 0x0A) continue
    add(spanHash(accum1, accum2), n)
    n = 0
    accum1 = 0
    accum2 = 0
  }
  if (n > 0) add(spanHash(accum1, accum2), n)
  const hashes = Uint32Array.from(counts.keys()).sort()
  return { hashes, bytes: Float64Array.from(hashes, (hash) => counts.get(hash)) }
}

// Two files' bytes, null for a link, which scores 0, as do sizes too far apart
// for `minimum`, unread. `counts` gives span counts, cached: one file meets many.
export function similarity(src, dst, minimum, counts) {
  if (src === null || dst === null) return 0
  const dstSize = dst.length, srcSize = src.length
  const max = Math.max(srcSize, dstSize)
  const delta = max - Math.min(srcSize, dstSize)
  if (max * (MAX_SCORE - minimum) < delta * MAX_SCORE) return 0
  if (dstSize === 0) return 0
  const a = counts(src), b = counts(dst)
  let copied = 0
  for (let i = 0, j = 0; i < a.hashes.length && j < b.hashes.length;) {
    if (a.hashes[i] < b.hashes[j]) i++
    else if (a.hashes[i] > b.hashes[j]) j++
    else copied += Math.min(a.bytes[i++], b.bytes[j++])
  }
  return Math.trunc(copied * MAX_SCORE / max)
}
