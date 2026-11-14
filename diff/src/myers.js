// Myers' O(ND) difference algorithm in its linear-space variation (Algorithmica 1, 1986), on lines
// interned to integers. No change set is returned before it is replayed against `a` and gives `b`.

import { lineComparisonKey } from './compare.js'
import { slideRuns } from './slide.js'

// Past this many edit steps in one subproblem, split at the furthest point reached rather than search on
// for a shortest change set, as GNU does unless --minimal
function costLimit(total) {
  let limit = 1
  for (let i = total; i !== 0; i >>= 2) limit <<= 1
  return Math.max(256, limit)
}

// `slide` settles a run that could sit in more than one place (slide.js), as every diff format does.
// `horizon` is how many of the lines the two files share at each end the search and the slide may use.
export function diffLines(a, b, { ignoreCase = false, whitespace = 'none', minimal = false, discard = true, slide = true, horizon = Infinity } = {}) {
  const key = lineComparisonKey({ ignoreCase, whitespace })
  // Equal files skip interning, but only when comparing is free: under a key, the scan would cost as much
  if (key === null && sameLines(a, b)) return []
  const { A, B, classes } = intern(a, b, key)
  const changedA = new Uint8Array(A.length)
  const changedB = new Uint8Array(B.length)
  const view = inView(a, b, horizon)
  // The search is given the lines in view less those set aside, by index; one set aside is changed without it
  const [asideA, asideB] = minimal || !discard ? [null, null] : setAside(A, B, classes, view)
  const xs = searched(view.lo, view.hiA, asideA, changedA), ys = searched(view.lo, view.hiB, asideB, changedB)
  compareSequences(xs.map((i) => A[i]), ys.map((i) => B[i]), xs, ys, changedA, changedB, minimal)
  if (slide) {
    // Both files keep every line before `lo`, so kept lines counted from there pair runs up as from the start
    const { lo, hiA, hiB } = view
    slideRuns(A.subarray(lo, hiA), changedA.subarray(lo, hiA), changedB.subarray(lo, hiB))
    slideRuns(B.subarray(lo, hiB), changedB.subarray(lo, hiB), changedA.subarray(lo, hiA))
  }
  const blocks = collectBlocks(changedA, changedB)
  verifyChangeSet(a, b, blocks, key)
  return blocks
}

// What the search and the slide see: a[lo..hiA) and b[lo..hiB), the shared start and then the shared end
// set aside but for `horizon` lines of each (GNU's find_identical_ends). Shared is the same text, which is
// the same line under any comparison.
function inView(a, b, horizon) {
  const shorter = Math.min(a.length, b.length)
  let start = 0
  while (start < shorter && a[start] === b[start]) start++
  const lo = Math.max(0, start - horizon)
  let end = 0
  while (end < shorter - lo && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const cut = Math.max(0, end - horizon)
  return { lo, hiA: a.length - cut, hiB: b.length - cut }
}

// GNU's discard_confusing_lines, figure for figure, so the search reaches the change set GNU reaches.
// A line matching no line in view in the other file can only be changed, so it is not searched, and nor
// is one matching many well inside a run of those: a blank line or a `}` amid rewritten lines.
function setAside(A, B, classes, { lo, hiA, hiB }) {
  const inA = new Int32Array(classes), inB = new Int32Array(classes)
  for (let i = lo; i < hiA; i++) inA[A[i]]++
  for (let i = lo; i < hiB; i++) inB[B[i]]++
  return [confusing(A.subarray(lo, hiA), inB), confusing(B.subarray(lo, hiB), inA)]
}

// 1 for a line set aside as matching none, 2 for one matching many, settled below, and 0 for one searched
function confusing(lines, matches) {
  const end = lines.length
  const marks = new Uint8Array(end)
  // Many is more than 5 under 256 lines in view, doubling as they grow fourfold
  let many = 5
  for (let tem = Math.floor(end / 64) >> 2; tem > 0; tem >>= 2) many *= 2
  for (let i = 0; i < end; i++) {
    const n = matches[lines[i]]
    if (n === 0) marks[i] = 1
    else if (n > many) marks[i] = 2
  }
  for (let i = 0; i < end; i++) {
    // One matching many is set aside only inside a run that starts and ends with lines matching none
    if (marks[i] === 2) { marks[i] = 0; continue }
    if (marks[i] === 0) continue
    let j = i, provisional = 0
    for (; j < end && marks[j] !== 0; j++) if (marks[j] === 2) provisional++
    while (j > i && marks[j - 1] === 2) { marks[--j] = 0; provisional-- }
    const length = j - i
    // A run more than a quarter such lines has them all searched
    if (provisional * 4 > length) {
      while (j > i) if (marks[--j] === 2) marks[j] = 0
      continue
    }
    // So does a stretch of them about as long as the root of a quarter of the run: 2 under 16 lines, 3 under 64
    let minimum = 1
    for (let tem = length >> 4; tem > 0; tem >>= 2) minimum <<= 1
    minimum++
    for (let consec = 0, k = 0; k < length; k++) {
      if (marks[i + k] !== 2) consec = 0
      else if (minimum === ++consec) k -= consec
      else if (minimum < consec) marks[i + k] = 0
    }
    searchNearEnd(marks, i, 1, length)
    searchNearEnd(marks, i + length - 1, -1, length)
    i += length - 1
  }
  return marks
}

// And so do those near either end of a run: up to three in a row matching nothing, or the first eight in
function searchNearEnd(marks, from, step, length) {
  for (let consec = 0, k = 0; k < length; k++) {
    const at = from + k * step
    if (k >= 8 && marks[at] === 1) break
    if (marks[at] === 2) { consec = 0; marks[at] = 0 }
    else if (marks[at] === 0) consec = 0
    else consec++
    if (consec === 3) break
  }
}

function searched(lo, hi, aside, changed) {
  const kept = []
  for (let i = lo; i < hi; i++) {
    if (aside !== null && aside[i - lo] !== 0) changed[i] = 1
    else kept.push(i)
  }
  return Int32Array.from(kept)
}

const equalUnder = (key) => (key ? (x, y) => key(x) === key(y) : (x, y) => x === y)

export function sameLines(a, b, key = null) {
  if (a.length !== b.length) return false
  const equal = equalUnder(key)
  for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false
  return true
}

function intern(a, b, key) {
  const ids = new Map()
  const assign = (line) => {
    const k = key ? key(line) : line
    let id = ids.get(k)
    if (id === undefined) { id = ids.size; ids.set(k, id) }
    return id
  }
  return { A: Int32Array.from(a, assign), B: Int32Array.from(b, assign), classes: ids.size }
}

// `xs` and `ys` map the searched lines back to the files'. A stack rather than recursion, as the cutoff
// can split unevenly and no depth should depend on the input.
function compareSequences(A, B, xs, ys, changedA, changedB, minimal) {
  const diagonals = A.length + B.length + 3
  // Diagonal d = x - y ranges over [-M-1, N+1], offset into the arrays
  const search = { A, B, fd: new Int32Array(diagonals), bd: new Int32Array(diagonals), base: B.length + 1, limit: costLimit(A.length + B.length) }
  const stack = [{ xoff: 0, xlim: A.length, yoff: 0, ylim: B.length, minimal }]
  while (stack.length) {
    let { xoff, xlim, yoff, ylim, minimal: findMinimal } = stack.pop()
    while (xoff < xlim && yoff < ylim && A[xoff] === B[yoff]) { xoff++; yoff++ }
    while (xoff < xlim && yoff < ylim && A[xlim - 1] === B[ylim - 1]) { xlim--; ylim-- }
    if (xoff === xlim) { for (; yoff < ylim; yoff++) changedB[ys[yoff]] = 1; continue }
    if (yoff === ylim) { for (; xoff < xlim; xoff++) changedA[xs[xoff]] = 1; continue }
    const { xmid, ymid, loMinimal, hiMinimal } = middleSnake(search, xoff, xlim, yoff, ylim, findMinimal)
    // The right half first, so the left is taken next
    stack.push({ xoff: xmid, xlim, yoff: ymid, ylim, minimal: hiMinimal })
    stack.push({ xoff, xlim: xmid, yoff, ylim: ymid, minimal: loMinimal })
  }
}

// A point on some shortest path, or past the cost limit the furthest either search reached, splitting the
// problem in two. Diagonals are numbered absolutely, so a subproblem needs no coordinate shift.
function middleSnake(search, xoff, xlim, yoff, ylim, findMinimal) {
  const { A, B, fd, bd, base, limit } = search
  const dmax = xlim - yoff, dmin = xoff - ylim
  const bmid = xlim - ylim, fmid = xoff - yoff
  let bmax = bmid, bmin = bmid, fmax = fmid, fmin = fmid
  const odd = ((fmid - bmid) & 1) !== 0
  fd[base + fmid] = xoff
  bd[base + bmid] = xlim
  for (let c = 1; ; c++) {
    if (fmin > dmin) fd[base + --fmin - 1] = -1
    else ++fmin
    if (fmax < dmax) fd[base + ++fmax + 1] = -1
    else --fmax
    for (let d = fmax; d >= fmin; d -= 2) {
      const thi = fd[base + d + 1], tlo = fd[base + d - 1]
      let x = tlo < thi ? thi : tlo + 1
      let y = x - d
      while (x < xlim && y < ylim && A[x] === B[y]) { x++; y++ }
      fd[base + d] = x
      if (odd && bmin <= d && d <= bmax && bd[base + d] <= x) return { xmid: x, ymid: y, loMinimal: true, hiMinimal: true }
    }
    if (bmin > dmin) bd[base + --bmin - 1] = 0x7FFFFFFF
    else ++bmin
    if (bmax < dmax) bd[base + ++bmax + 1] = 0x7FFFFFFF
    else --bmax
    for (let d = bmax; d >= bmin; d -= 2) {
      const thi = bd[base + d + 1], tlo = bd[base + d - 1]
      let x = tlo < thi ? tlo : thi - 1
      let y = x - d
      while (xoff < x && yoff < y && A[x - 1] === B[y - 1]) { x--; y-- }
      bd[base + d] = x
      if (!odd && fmin <= d && d <= fmax && x <= fd[base + d]) return { xmid: x, ymid: y, loMinimal: true, hiMinimal: true }
    }
    if (!findMinimal && c >= limit) return splitAtFurthest(search, { xoff, xlim, yoff, ylim, fmin, fmax, bmin, bmax })
  }
}

// The forward or backward point that got furthest, whichever made more progress: any point a search
// reached is on a valid path, so the halves either side still compose into a correct change set
function splitAtFurthest(search, bounds) {
  const { fd, bd, base } = search
  const { xoff, xlim, yoff, ylim, fmin, fmax, bmin, bmax } = bounds
  let fxbest = 0, fxybest = -1
  for (let d = fmax; d >= fmin; d -= 2) {
    let x = Math.min(fd[base + d], xlim)
    let y = x - d
    if (ylim < y) { x = ylim + d; y = ylim }
    if (fxybest < x + y) { fxybest = x + y; fxbest = x }
  }
  let bxbest = 0, bxybest = 0x7FFFFFFF
  for (let d = bmax; d >= bmin; d -= 2) {
    let x = Math.max(xoff, bd[base + d])
    let y = x - d
    if (y < yoff) { x = yoff + d; y = yoff }
    if (x + y < bxybest) { bxybest = x + y; bxbest = x }
  }
  if (xlim + ylim - bxybest < fxybest - (xoff + yoff)) return { xmid: fxbest, ymid: fxybest - fxbest, loMinimal: true, hiMinimal: false }
  return { xmid: bxbest, ymid: bxybest - bxbest, loMinimal: false, hiMinimal: true }
}

// Runs of changed lines, paired up: a[a0..a1) replaced by b[b0..b1), either side empty but not both
function collectBlocks(changedA, changedB) {
  const blocks = []
  const M = changedB.length, N = changedA.length
  let i = 0, j = 0
  while (i < N || j < M) {
    if (i < N && j < M && !changedA[i] && !changedB[j]) { i++; j++; continue }
    const a0 = i, b0 = j
    while (i < N && changedA[i]) i++
    while (j < M && changedB[j]) j++
    if (a0 === i && b0 === j) throw new DiffError('a kept line has no counterpart')
    blocks.push({ a0, a1: i, b0, b1: j })
  }
  return blocks
}

// The guarantee: what lies between the blocks has to be the same lines in `a` and `b`, under the
// comparison in force. The strings are compared, not interned ids, so the interning is checked too.
export function verifyChangeSet(a, b, blocks, key = null) {
  const equal = equalUnder(key)
  let ai = 0, bi = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    if (a0 < ai || b0 < bi || a1 < a0 || b1 < b0 || a1 > a.length || b1 > b.length) throw new DiffError('a block is out of order or out of range')
    if (a0 === a1 && b0 === b1) throw new DiffError('a block changes nothing')
    if (a0 - ai !== b0 - bi) throw new DiffError('the kept lines before a block differ in count')
    for (; ai < a0; ai++, bi++) if (!equal(a[ai], b[bi])) throw new DiffError(`kept line ${ai + 1} does not match`)
    ai = a1
    bi = b1
  }
  if (a.length - ai !== b.length - bi) throw new DiffError('the kept lines after the last block differ in count')
  for (; ai < a.length; ai++, bi++) if (!equal(a[ai], b[bi])) throw new DiffError(`kept line ${ai + 1} does not match`)
}

export class DiffError extends Error {
  constructor(detail) {
    super(`the computed change set does not reconstruct the second file (${detail})`)
    this.name = 'DiffError'
  }
}
