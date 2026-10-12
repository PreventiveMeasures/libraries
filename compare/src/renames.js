// git's -M pairing (diffcore_rename_extended): identical content, then a
// basename unique among both sides' leftovers at a stricter score, then every
// pair left scored; between the first two, ours, renames told by path.

import { crc32 } from '@exodus/bytes/crc.js'
import { onlyPartners, renameKeys } from './paths.js'
import { MAX_SCORE, similarity, spanCounts } from './similarity.js'
import { bytesOf, sameContent } from './tree.js'

// git's limits: identical files weighed per destination, scores kept per one.
const SAME_CONTENT_CANDIDATES = 100
const CANDIDATES = 4

const basename = (path) => path.slice(path.lastIndexOf('/') + 1)

// A CRC-32, to bucket files of equal bytes; sameContent still decides.
function contentKey(file, bytes) {
  if (file.type === 'symlink') return `l${file.target}`
  const data = bytes(file)
  return `f${data.length}:${crc32(data)}`
}

// git's find_identical_files: the first unused identical source of the same
// basename among the first 100, or else the first of them.
function exactRenames({ sources, dests, sourceNames, destNames, used, record, bytes }) {
  const byContent = Map.groupBy(sources.keys(), (s) => contentKey(sources[s], bytes))
  for (let d = 0; d < dests.length; d++) {
    let best = -1, left = SAME_CONTENT_CANDIDATES
    for (const s of byContent.get(contentKey(dests[d], bytes)) ?? []) {
      if (used.has(s) || !sameContent(sources[s], dests[d])) continue
      if (best === -1 || sourceNames[s] === destNames[d]) best = s
      if (sourceNames[s] === destNames[d] || --left === 0) break
    }
    if (best !== -1) record(d, best, MAX_SCORE)
  }
}

// A TypeScript extension and the JavaScript one it compiles to.
const SCRIPTS = new Map([['.ts', '.js'], ['.mts', '.mjs'], ['.cts', '.cjs'], ['.tsx', '.jsx']])

function splitPath(path) {
  const dirs = path.split('/')
  const name = dirs.pop()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { dirs, stem: name.slice(0, dot), extension: name.slice(dot) } : { dirs, stem: name, extension: '' }
}

// A path less what a build changes: `lib` and `src` alike, and a TypeScript
// extension as its JavaScript one.
function buildKey(path) {
  const { dirs, stem, extension } = splitPath(path)
  return JSON.stringify([dirs.map((dir) => (dir === 'lib' || dir === 'src' ? null : dir)), stem, SCRIPTS.get(extension) ?? extension])
}

// Whether either file of a pair by path has a candidate that is a rename by
// itself and scores at least halfway from the pair's score to 100%.
function outdone({ pairs, used, scoreOf }, { remaining, open }, { s, d, score }, minimum) {
  const better = Math.max(minimum, score + Math.trunc((MAX_SCORE - score) / 2))
  return open.some((o) => o !== d && !pairs.has(o) && scoreOf(s, o, minimum) >= better)
    || remaining.some((r) => r !== s && !used.has(r) && scoreOf(r, d, minimum) >= better)
}

// Paths a build changes: however a pair scores, the best of a file's partners.
function buildRenames(context, left, weigh, minimum) {
  const { sources, dests, pairs, used, record, scoreOf } = context
  const byKey = Map.groupBy(left.remaining.filter((s) => sources[s].type === 'file'), (s) => buildKey(sources[s].path))
  const candidates = left.open.filter((d) => dests[d].type === 'file')
    .flatMap((d) => (byKey.get(buildKey(dests[d].path)) ?? []).map((s) => ({ s, d, score: scoreOf(s, d, 0) })))
  for (const pair of candidates.sort((x, y) => y.score - x.score)) {
    if (!pairs.has(pair.d) && !used.has(pair.s) && !(weigh && outdone(context, left, pair, minimum))) record(pair.d, pair.s, pair.score)
  }
}

// Paths triage's Compare pairs: one file each other's only partner by family
// and directory, however the pair scores.
function familyRenames(context, left, weigh, minimum) {
  const { sources, dests, pairs, used, record, scoreOf } = context
  const keyed = (files, indices) => new Map(indices.filter((i) => files[i].type === 'file').map((i) => [i, renameKeys(files[i].path)]))
  for (const [s, d] of onlyPartners(keyed(sources, left.remaining.filter((r) => !used.has(r))), keyed(dests, left.open.filter((o) => !pairs.has(o))))) {
    const pair = { s, d, score: scoreOf(s, d, 0) }
    if (!(weigh && outdone(context, left, pair, minimum))) record(d, s, pair.score)
  }
}

// Renames told by path, which git does not look for. Past the rename limit no
// other candidate is scored, so none can be better.
function pathRenames(context, minimum, limit) {
  const left = unpaired(context)
  const weigh = left.remaining.length * left.open.length <= limit * limit
  buildRenames(context, left, weigh, minimum)
  familyRenames(context, left, weigh, minimum)
}

// Each index by its basename, or -1 where two share one.
function byBasename(names, indices) {
  const map = new Map()
  for (const i of indices) map.set(names[i], map.has(names[i]) ? -1 : i)
  return map
}

function basenameRenames({ sourceNames, destNames, record, scoreOf }, { remaining, open }, minimum) {
  const byDest = byBasename(destNames, open), bySource = byBasename(sourceNames, remaining)
  for (const s of remaining) {
    const d = byDest.get(sourceNames[s])
    if (d === undefined || d === -1 || bySource.get(sourceNames[s]) === -1) continue
    const score = scoreOf(s, d, minimum)
    if (score >= minimum) record(d, s, score)
  }
}

// git's candidate order: best score, then a shared basename. Sorts are stable,
// as git's is, so equals keep destination and slot order.
const byScore = (a, b) => b.score - a.score || b.nameScore - a.nameScore

// git's record_if_better: the first of the worst kept is replaced by a better.
function keepIfBetter(kept, candidate) {
  if (kept.length < CANDIDATES) {
    kept.push(candidate)
    return
  }
  let worst = 0
  for (let i = 1; i < kept.length; i++) if (byScore(kept[i], kept[worst]) > 0) worst = i
  if (byScore(kept[worst], candidate) > 0) kept[worst] = candidate
}

function scoredRenames({ sourceNames, destNames, pairs, used, record, scoreOf }, { remaining, open }, minimum) {
  const all = []
  for (const d of open) {
    const kept = []
    for (const s of remaining) keepIfBetter(kept, { score: scoreOf(s, d, minimum), nameScore: sourceNames[s] === destNames[d] ? 1 : 0, dst: d, src: s })
    all.push(...kept)
  }
  for (const { dst, src, score } of all.sort(byScore)) {
    if (score < minimum) break
    if (!pairs.has(dst) && !used.has(src)) record(dst, src, score)
  }
}

const unpaired = ({ sources, dests, pairs, used }) => ({
  remaining: sources.keys().filter((s) => !used.has(s)).toArray(),
  open: dests.keys().filter((d) => !pairs.has(d)).toArray(),
})

// Each added file's rename by its index in `dests`: { source, score }. A
// `minimum` of MAX_SCORE takes identical content alone, but for `byPath`, and
// more than `limit` squared pairs left skips the scoring.
export function findRenames(sources, dests, { minimum, limit, byPath }) {
  const pairs = new Map(), used = new Set()
  if (sources.length === 0 || dests.length === 0) return pairs
  // A file's bytes, its text encoded once, and their span counts once.
  const counted = new Map(), encoded = new Map()
  const bytes = (file) => {
    if (file.type !== 'file') return null
    if (!encoded.has(file)) encoded.set(file, bytesOf(file.data))
    return encoded.get(file)
  }
  const counts = (data) => {
    if (!counted.has(data)) counted.set(data, spanCounts(data))
    return counted.get(data)
  }
  const context = {
    sources, dests, pairs, used,
    sourceNames: sources.map((file) => basename(file.path)),
    destNames: dests.map((file) => basename(file.path)),
    record(d, s, score) {
      pairs.set(d, { source: s, score })
      used.add(s)
    },
    bytes,
    scoreOf: (s, d, least) => similarity(bytes(sources[s]), bytes(dests[d]), least, counts),
  }
  exactRenames(context)
  if (byPath) pathRenames(context, minimum, limit)
  if (minimum >= MAX_SCORE) return pairs
  basenameRenames(context, unpaired(context), minimum + Math.trunc(0.5 * (MAX_SCORE - minimum)))
  const left = unpaired(context)
  if (left.remaining.length * left.open.length <= limit * limit) scoredRenames(context, left, minimum)
  return pairs
}
