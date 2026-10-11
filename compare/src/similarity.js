// How much of one file another accounts for, as git estimates it when it
// looks for renames: diffcore-delta.c, and estimate_similarity in
// diffcore-rename.c, as they stand from git 2.44 on. What git finds a rename
// is decided here, so it is git's arithmetic to the bit -- its hash, its
// 32-bit wraparound, its truncations -- and not a better measure of its own.
//
// The idea is git's: cut each file into spans, each ending at a newline or
// after 64 bytes, hash them into a little over 2^16 buckets, and count the
// bytes under each hash. Bytes of the new file under a hash the old file has
// as many bytes under were copied from it; the score is what was copied over
// the larger of the two sizes. It is a count, not an alignment: lines
// shuffled score as lines kept, and two spans that share a bucket count as
// one. Before 2.44, git left out a last span with no newline after it.

// git's scale: a score is out of 60000, and 50% is 30000.
export const MAX_SCORE = 60000

// A prime between 2^16 and 2^17, so the counts stay in git's largest table.
const HASHBASE = 107927

// What git takes for binary content: a NUL among the first 8000 bytes.
// Text has a CR before an LF passed over, so a file and its CRLF twin count
// the same.
const FIRST_FEW_BYTES = 8000
const looksBinary = (data) => data.subarray(0, FIRST_FEW_BYTES).includes(0)

const spanHash = (accum1, accum2) => ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE

// The bytes of a file under each span hash, as git keeps them: in order of
// hash, so two files are compared by one walk down both.
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

// The score `dst` gets as a copy of `src`, out of MAX_SCORE, where `minimum`
// is the least that would count; `counts` gives a file's span counts, and
// may keep them, since one file is scored against many. Only files are
// scored: a link is renamed only when nothing about it changed. Nor are two
// files whose sizes differ by more than `minimum` allows, which are scored 0
// without being read.
export function similarity(src, dst, minimum, counts) {
  if (src.type !== 'file' || dst.type !== 'file') return 0
  const dstSize = dst.data.length, srcSize = src.data.length
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
