// git's rename score (diffcore-delta.c, estimate_similarity in diffcore-rename.c,
// git >= 2.44), bit for bit since it decides which renames git finds: bytes of
// the new file in spans the old file has too, over the larger file's size.

// Scores are out of 60000; 50% is 30000.
export const MAX_SCORE = 60000

const HASHBASE = 107927

// git's binary test, used here only to decide whether a CR before an LF counts.
const looksBinary = (data) => data.subarray(0, 8000).includes(0)

const spanHash = (accum1, accum2) => ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE

// The bytes a span ends after: git's LF, and for code minified onto a line or
// a few (chunks.js), punctuation too, so that an edit shifts no span past it.
const endingAfter = (chars) => Uint8Array.from({ length: 256 }, (_, c) => Number(c === 0x0A || chars.includes(String.fromCodePoint(c))))
const LINES = endingAfter('')
export const PUNCTUATION = endingAfter(',;={}')

// Bytes per span hash, a span ending after a byte `ends` has or 64 bytes;
// sorted by hash, as git keeps them, so two files compare in one walk down both.
export function spanCounts(data, ends = LINES) {
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
    if (++n < 64 && ends[c] === 0) continue
    add(spanHash(accum1, accum2), n)
    n = 0
    accum1 = 0
    accum2 = 0
  }
  if (n > 0) add(spanHash(accum1, accum2), n)
  const hashes = Uint32Array.from(counts.keys()).sort()
  return { hashes, bytes: Float64Array.from(hashes, (hash) => counts.get(hash)), total: counts.values().reduce((sum, bytes) => sum + bytes, 0) }
}

// Bytes of spans both have: git's walk down both.
function copiedBytes(a, b) {
  let copied = 0
  for (let i = 0, j = 0; i < a.hashes.length && j < b.hashes.length;) {
    if (a.hashes[i] < b.hashes[j]) i++
    else if (a.hashes[i] > b.hashes[j]) j++
    else copied += Math.min(a.bytes[i++], b.bytes[j++])
  }
  return copied
}

// The same, or 0 once the spans left could no longer bring it to `least`: a
// score times the larger file's size, as the bytes copied times MAX_SCORE are.
function copiedReaching(a, b, least) {
  let copied = 0, restA = a.total, restB = b.total
  for (let i = 0, j = 0; i < a.hashes.length && j < b.hashes.length;) {
    if (a.hashes[i] < b.hashes[j]) restA -= a.bytes[i++]
    else if (a.hashes[i] > b.hashes[j]) restB -= b.bytes[j++]
    else {
      copied += Math.min(a.bytes[i], b.bytes[j])
      restA -= a.bytes[i++]
      restB -= b.bytes[j++]
    }
    if ((copied + Math.min(restA, restB)) * MAX_SCORE < least) return 0
  }
  return copied
}

// Two files' bytes, null for a link, which scores 0, as do sizes too far apart
// for `minimum`, unread. `counts` gives span counts, cached: one file meets
// many. `early`, spans that can no longer reach `minimum` score 0 unwalked: not
// for git's passes, whose candidates below it break ties by their scores.
export function similarity(src, dst, minimum, counts, early = false) {
  if (src === null || dst === null || dst.length === 0) return 0
  const delta = Math.abs(src.length - dst.length), max = Math.max(src.length, dst.length)
  if (max * (MAX_SCORE - minimum) < delta * MAX_SCORE) return 0
  const a = counts(src), b = counts(dst)
  const copied = early ? copiedReaching(a, b, minimum * max) : copiedBytes(a, b)
  return Math.trunc(copied * MAX_SCORE / max)
}
