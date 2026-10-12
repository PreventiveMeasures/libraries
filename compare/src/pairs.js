// Which of a change's removed lines was edited into which added one: the best
// pairing in order where weighing every pair is cheap enough, else a lookahead.

import { MAX_CHANGED, tokenized } from './words.js'

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

// How much of each pair of lines changed, Infinity where they are no line
// edited, and the work weighing them has taken: counts compared, then the
// steps of a shortest edit script (Myers) between their words, carrying on each
// diagonal the characters in common along its path.
function weigher(olds, news) {
  const known = new Map()
  const reads = [olds, news].map((side) => side.map((line) => tokenized(line, known)))
  const counts = reads.map((side) => side.map(counted))
  const lengths = []
  for (const [token, word] of known) lengths[word] = token.length
  let work = 0
  // Whether the words `others` holds fewer of alone come to more of `line` than an edit changes.
  const exceeds = (mine, others, line) => {
    let changed = 0
    for (const [word, count] of mine) {
      work += VISIT
      const other = others.get(word) ?? 0
      if (count > other && (changed += lengths[word] * (count - other)) / Math.max(1, line.length) > MAX_CHANGED) return true
    }
    return false
  }
  // One buffer for every script, wide enough for the longest two lines.
  const offset = 2 * Math.max(0, ...reads.flat().map((read) => read?.words.length ?? 0)) + 1
  const ends = new Int32Array(2 * offset + 1), kept = new Float64Array(2 * offset + 1)
  // The ends two lines share are matched outright, an edit seldom spanning a line.
  const common = (a, b) => {
    let first = 0, same = 0
    for (; first < a.length && first < b.length && a[first] === b[first]; first++) same += lengths[a[first]]
    let m = b.length, n = a.length
    for (; n > first && m > first && a[n - 1] === b[m - 1]; n--, m--) same += lengths[a[n - 1]]
    work += a.length + b.length - n - m + 2 * first
    ends[offset + 1] = first
    kept[offset + 1] = 0
    for (let d = 0; d <= n + m - 2 * first; d++) {
      for (let k = -d; k <= d; k += 2) {
        const down = k === -d || (k !== d && ends[offset + k - 1] < ends[offset + k + 1])
        const start = down ? ends[offset + k + 1] : ends[offset + k - 1] + 1
        let count = down ? kept[offset + k + 1] : kept[offset + k - 1], x = start, y = start - k
        for (; x < n && y < m && a[x] === b[y]; x++, y++) count += lengths[a[x]]
        work += 1 + x - start
        ends[offset + k] = x
        kept[offset + k] = count
        if (x >= n && y >= m) return same + count
      }
    }
    return same
  }
  // As wordChanges has it, but for whitespace between two changes, which a word view marks too.
  const weighed = (i, j) => {
    work += PAIR
    if (reads[0][i] === null || reads[1][j] === null) return Infinity
    if (exceeds(counts[0][i], counts[1][j], olds[i]) && exceeds(counts[1][j], counts[0][i], news[j])) return Infinity
    const same = common(reads[0][i].words, reads[1][j].words)
    const share = Math.min(1 - same / Math.max(1, olds[i].length), 1 - same / Math.max(1, news[j].length))
    return same > 0 && share <= MAX_CHANGED ? share : Infinity
  }
  const shares = new Float64Array(olds.length * news.length).fill(Number.NaN)
  const share = (i, j) => {
    const key = i * news.length + j
    if (Number.isNaN(shares[key])) shares[key] = olds[i] === news[j] ? 0 : weighed(i, j)
    return shares[key]
  }
  return { share, spent: () => work }
}

// The pairs in order that are the most, and of those the most alike, a pair
// weighed 1000 less its share; null where weighing them all passes the budget.
function aligned(n, m, { share, spent }) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) if (share(i, j) >= 0 && spent() > BUDGET) return null
  }
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
// after the last one paired.
function lookedAhead(n, m, share) {
  const pairs = []
  for (let i = 0, next = 0; i < n && next < m; i++) {
    let best = null, least = Infinity
    for (let j = next; j < Math.min(m, next + LOOKAHEAD) && least > 0; j++) {
      if (share(i, j) < least) [best, least] = [j, share(i, j)]
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
  return aligned(olds.length, news.length, weigh) ?? lookedAhead(olds.length, news.length, weigh.share)
}
