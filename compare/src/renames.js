// Which deleted file each added file was, as git pairs them under -M
// (diffcore_rename_extended in diffcore-rename.c), in its three passes:
//
// 1. Identical content. Each added file, in path order, takes the first
//    deleted file it is byte for byte, preferring one of its own basename;
//    a file matches a file whatever their modes, a link only a link. A
//    rename like this scores 100%, whatever else it changed.
// 2. A basename one deleted file and one added file alone have, among those
//    left: the two are a rename when they score halfway from the minimum to
//    100%. Most renames move a file and keep its name, and this finds them
//    without scoring every pair.
// 3. Every pair left, scored, if there are few enough of them: each added
//    file keeps its four best, the best of all are taken first, and a file
//    once taken is not taken again.
//
// The order things are tried in is git's, and decides ties as git's does, so
// `sources` (the deleted files) and `dests` (the added) come in path order.

import { MAX_SCORE, similarity, spanCounts } from './similarity.js'
import { sameContent } from './tree.js'

// How many identical files are weighed for one before the first is taken.
const SAME_CONTENT_CANDIDATES = 100
// How many sources each destination keeps of its scores.
const CANDIDATES = 4

const basename = (path) => path.slice(path.lastIndexOf('/') + 1)
const sameBasename = (a, b) => (basename(a) === basename(b) ? 1 : 0)

// FNV-1a, to put files of equal bytes in one bucket; the bytes still decide.
function contentKey(file) {
  if (file.type === 'symlink') return `l${file.target}`
  let hash = 0x811C9DC5
  for (const byte of file.data) hash = Math.imul(hash ^ byte, 0x01000193)
  return `f${file.data.length}:${hash >>> 0}`
}

function exactRenames({ sources, dests, used, record }) {
  const byContent = new Map()
  for (const [s, file] of sources.entries()) {
    const key = contentKey(file)
    if (byContent.has(key)) byContent.get(key).push(s)
    else byContent.set(key, [s])
  }
  for (const [d, file] of dests.entries()) {
    let best = -1, bestScore = 0, left = SAME_CONTENT_CANDIDATES
    for (const s of byContent.get(contentKey(file)) ?? []) {
      if (used.has(s) || !sameContent(sources[s], file)) continue
      const score = 1 + sameBasename(sources[s].path, file.path)
      if (score > bestScore) {
        best = s
        bestScore = score
        if (score === 2) break
      }
      if (--left === 0) break
    }
    if (best !== -1) record(d, best, MAX_SCORE)
  }
}

// Each index of `files` among `indices` by its basename, or -1 for a
// basename two of them share.
function byBasename(files, indices) {
  const map = new Map()
  for (const i of indices) {
    const base = basename(files[i].path)
    map.set(base, map.has(base) ? -1 : i)
  }
  return map
}

function basenameRenames({ sources, dests, remaining, open, pairs, record, score }, minimum) {
  const byDest = byBasename(dests, open), bySource = byBasename(sources, remaining)
  for (const s of remaining) {
    const base = basename(sources[s].path)
    const d = byDest.get(base)
    if (d === undefined || d === -1 || bySource.get(base) === -1 || pairs.has(d)) continue
    const scored = score(s, d, minimum)
    if (scored >= minimum) record(d, s, scored)
  }
}

// git's order for candidates: the best score first, a shared basename first
// among equal scores, and an empty slot last of all.
function byScore(a, b) {
  if (a.dst < 0) return b.dst >= 0 ? 1 : 0
  if (b.dst < 0) return -1
  if (a.score === b.score) return b.nameScore - a.nameScore
  return b.score - a.score
}

// Into the slot of the worst candidate kept, the first of equals, if this
// one is better.
function keepIfBetter(kept, candidate) {
  let worst = 0
  for (let i = 1; i < kept.length; i++) if (byScore(kept[i], kept[worst]) > 0) worst = i
  if (byScore(kept[worst], candidate) > 0) kept[worst] = candidate
}

const EMPTY = { dst: -1 }

function scoredRenames({ sources, dests, remaining, open, pairs, used, record, score }, minimum) {
  const all = []
  for (const d of open) {
    const kept = Array.from({ length: CANDIDATES }, () => EMPTY)
    for (const s of remaining) {
      keepIfBetter(kept, { score: score(s, d, minimum), nameScore: sameBasename(sources[s].path, dests[d].path), dst: d, src: s })
    }
    all.push(...kept)
  }
  // Array sort is stable, as git's is, so equals stay in destination order.
  all.sort(byScore)
  for (const { dst, src, score: scored } of all) {
    if (dst < 0 || scored < minimum) break
    if (pairs.has(dst) || used.has(src)) continue
    record(dst, src, scored)
  }
}

// The rename each added file is, by its index in `dests`: the index of the
// deleted file in `sources` it was, and the score that says so. `minimum` is
// the least score a rename takes, MAX_SCORE for identical content alone, and
// the scored pass is skipped when more than `limit` squared pairs are left.
export function findRenames(sources, dests, { minimum, limit }) {
  const pairs = new Map(), used = new Set()
  const record = (d, s, score) => {
    pairs.set(d, { source: s, score })
    used.add(s)
  }
  const state = { sources, dests, pairs, used, record }
  exactRenames(state)
  if (minimum >= MAX_SCORE) return pairs

  const counted = new WeakMap()
  const counts = (file) => {
    if (!counted.has(file)) counted.set(file, spanCounts(file.data))
    return counted.get(file)
  }
  state.score = (s, d, least) => similarity(sources[s], dests[d], least, counts)
  const left = () => {
    state.remaining = sources.keys().filter((s) => !used.has(s)).toArray()
    state.open = dests.keys().filter((d) => !pairs.has(d)).toArray()
  }

  left()
  basenameRenames(state, minimum + Math.trunc(0.5 * (MAX_SCORE - minimum)))
  left()
  const { remaining, open } = state
  if (remaining.length === 0 || open.length === 0 || remaining.length * open.length > limit * limit) return pairs
  scoredRenames(state, minimum)
  return pairs
}
