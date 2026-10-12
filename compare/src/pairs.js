// Which of a change's removed lines was edited into which added one: the best
// pairing in order where weighing every pair is cheap enough, else a lookahead.

import { scripter } from './script.js'
import { MAX_CHANGED, changedShare, lexicon, tokenized } from './words.js'

// The longest change whose lines are paired at all; the most work weighing all
// its pairs may take, in steps; and past it, how far ahead a removed line looks
// for an added one instead.
const MAX_LINES = 200
const BUDGET = 5_000_000
const LOOKAHEAD = 6
// What a pair weighed and a word's count compared cost, in steps of a script.
const PAIR = 60
const VISIT = 3

function counted(read) {
  const counts = new Map()
  for (const word of read?.words ?? []) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

// How much of each pair of lines changed, as wordRanges marks it, Infinity
// where they are no line edited; and the work weighing them has taken.
function weigher(olds, news) {
  const words = lexicon()
  const reads = [olds, news].map((side) => side.map((line) => tokenized(line, words)))
  const counts = reads.map((side) => side.map(counted))
  const script = scripter(Math.max(0, ...reads.flat().map((read) => read?.words.length ?? 0)), words.lengths, words.blanks)
  let work = 0
  // The least share of `line` changed, from the words `others` holds fewer of; past `most`, any more.
  const unmatched = (mine, others, line, most) => {
    let changed = 0
    for (const [word, count] of mine) {
      work += VISIT
      const other = others.get(word) ?? 0
      if (count > other && (changed += words.lengths[word] * (count - other)) / Math.max(1, line.length) > most) break
    }
    return changed / Math.max(1, line.length)
  }
  // The least share of the pair changed, as their counts alone tell: the script can only find more.
  const floor = (i, j, most = Infinity) => (reads[0][i] === null || reads[1][j] === null ? Infinity
    : Math.min(unmatched(counts[0][i], counts[1][j], olds[i], most), unmatched(counts[1][j], counts[0][i], news[j], most)))
  const weighed = (i, j) => {
    work += PAIR
    if (floor(i, j, MAX_CHANGED) > MAX_CHANGED) return Infinity
    const found = script(reads[0][i].words, reads[1][j].words)
    work += found.steps
    const share = changedShare(found, reads[0][i], reads[1][j])
    return share <= MAX_CHANGED ? share : Infinity
  }
  const shares = new Float64Array(olds.length * news.length).fill(Number.NaN)
  const share = (i, j) => {
    const key = i * news.length + j
    if (Number.isNaN(shares[key])) shares[key] = olds[i] === news[j] ? 0 : weighed(i, j)
    return shares[key]
  }
  return { share, floor, spent: () => work, charge: (steps) => (work += steps) }
}

// The pairs in order that are the most, and of those the most alike, a pair
// weighed 1000 less its share; null where weighing them all passes the budget.
function aligned(n, m, { share, spent, charge }) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) if (share(i, j) >= 0 && spent() > BUDGET) return null
  }
  if (charge(n * m) > BUDGET) return null
  const value = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  const take = (i, j) => (share(i, j) === Infinity ? -Infinity : 1000 - share(i, j) + value[i + 1][j + 1])
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) value[i][j] = Math.max(value[i + 1][j], value[i][j + 1], take(i, j))
  }
  const pairs = []
  for (let i = 0, j = 0; i < n && j < m;) {
    if (value[i][j] === take(i, j)) pairs.push([i++, j++])
    else if (value[i][j] === value[i + 1][j]) i++
    else j++
  }
  return pairs
}

// Each removed line in turn paired with the most alike of the next added lines
// after the last one paired, those whose counts show less changed weighed first.
function lookedAhead(n, m, { share, floor }) {
  const pairs = []
  for (let i = 0, next = 0; i < n && next < m; i++) {
    let best = null, least = Infinity
    const ahead = Array.from({ length: Math.min(m, next + LOOKAHEAD) - next }, (_, at) => [next + at, floor(i, next + at)])
    for (const [j, low] of ahead.toSorted((p, q) => p[1] - q[1] || p[0] - q[0])) {
      if (low > least) break
      if (share(i, j) < least || (share(i, j) === least && j < best)) [best, least] = [j, share(i, j)]
    }
    if (best !== null) {
      pairs.push([i, best])
      next = best + 1
    }
  }
  return pairs
}

export function pairLines(olds, news) {
  if (olds.length > MAX_LINES || news.length > MAX_LINES) return []
  const weigh = weigher(olds, news)
  return aligned(olds.length, news.length, weigh) ?? lookedAhead(olds.length, news.length, weigh)
}
