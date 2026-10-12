// Which of a change's removed lines was edited into which added one: the best
// pairing in order where weighing every pair is cheap enough, else a lookahead.

import { MAX_CHANGED, tokenized, wordChanges } from './words.js'

// The longest change whose lines are paired at all; the most work weighing all
// its pairs may take, in steps; and past it, how far ahead a removed line looks
// for an added one instead.
const MAX_LINES = 200
const BUDGET = 5_000_000
const LOOKAHEAD = 6
// The most work pairing may take at all, past which lines are left unpaired.
const LIMIT = 20_000_000
// What a pair weighed, a word's count compared and a word of @preventive/diff's
// diff cost, in steps of a script; its diff costs the script's steps besides.
const PAIR = 60
const VISIT = 3
const EXACT = 50

function counted(read) {
  const counts = new Map()
  for (const word of read?.words ?? []) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

// What of each of two lines' words a shortest edit script between them keeps
// (Myers), their shared ends matched outright, less the blanks a word view
// takes into the changes either side of them: each diagonal carries, for each
// side, what its path keeps, the blanks kept since that side last changed, and
// whether nothing but blanks has been kept since. `edits` is the script's
// length, `steps` the work, the diagonals off both middles never walked.
function scripter(width, lengths, blanks) {
  const at = width + 1, size = 2 * width + 3
  // Per diagonal: where its path ends; what each side keeps and has kept as blanks since it changed (four
  // in a row); and as bits, whether each side has kept only blanks since it changed, and whether any word.
  const counts = new Int32Array(4 * size), ends = new Int32Array(size), flags = new Uint8Array(size)
  const result = { kept: [0, 0], seen: false, edits: 0, steps: 0 }
  return (a, b) => {
    let first = 0, same = 0
    for (; first < a.length && first < b.length && a[first] === b[first]; first++) same += lengths[a[first]]
    let m = b.length, n = a.length
    for (; n > first && m > first && a[n - 1] === b[m - 1]; n--, m--) same += lengths[a[n - 1]]
    result.steps = a.length + b.length - n - m + 2 * first
    ends[at + 1] = first
    counts.fill(0, 4 * (at + 1), 4 * (at + 2))
    flags[at + 1] = 0
    const high = n - first, low = first - m
    for (let d = 0; d <= n + m - 2 * first; d++) {
      for (let k = Math.max(-d, low + ((low + d) & 1)); k <= Math.min(d, high); k += 2) {
        const down = k === -d || k - 1 < low || (k !== d && k + 1 <= high && ends[at + k - 1] < ends[at + k + 1])
        const from = at + (down ? k + 1 : k - 1), to = at + k
        const start = down ? ends[from] : ends[from] + 1
        let bits = flags[from], ka = counts[4 * from], kb = counts[4 * from + 1], pa = counts[4 * from + 2], pb = counts[4 * from + 3]
        // A word taken away changes the old side, one put in the new: blanks kept since its last change join them.
        if (d > 0 && down) {
          if (bits & 2) kb -= pb
          bits |= 2
          pb = 0
        } else if (d > 0) {
          if (bits & 1) ka -= pa
          bits |= 1
          pa = 0
        }
        let x = start, y = start - k
        for (; x < n && y < m && a[x] === b[y]; x++, y++) {
          const length = lengths[a[x]]
          ka += length
          kb += length
          if (blanks[a[x]]) {
            pa += length
            pb += length
          } else {
            bits &= 4
          }
          bits |= 4
        }
        result.steps += 2 + x - start
        ends[to] = x
        counts[4 * to] = ka
        counts[4 * to + 1] = kb
        counts[4 * to + 2] = pa
        counts[4 * to + 3] = pb
        flags[to] = bits
        if (x >= n && y >= m) {
          result.kept = [same + ka, same + kb]
          result.seen = same > 0 || (bits & 4) !== 0
          result.edits = d
          return result
        }
      }
    }
    return result
  }
}

// How much of each pair of lines changed, as a word view marks it, Infinity
// where they are no line edited; and the work weighing them has taken.
function weigher(olds, news) {
  const known = new Map()
  const reads = [olds, news].map((side) => side.map((line) => tokenized(line, known)))
  const counts = reads.map((side) => side.map(counted))
  const [lengths, blanks] = [[], []]
  for (const [token, word] of known) [lengths[word], blanks[word]] = [token.length, /^\s/u.test(token)]
  const longest = reads.map((side) => side.map((read) => Math.max(0, ...read?.words.map((word) => lengths[word]) ?? [])))
  const common = scripter(Math.max(0, ...reads.flat().map((read) => read?.words.length ?? 0)), lengths, blanks)
  let work = 0
  // The least share of `line` changed, from the words `others` holds fewer of; past `most`, any more.
  const unmatched = (mine, others, line, most) => {
    let changed = 0
    for (const [word, count] of mine) {
      work += VISIT
      const other = others.get(word) ?? 0
      if (count > other && (changed += lengths[word] * (count - other)) / Math.max(1, line.length) > most) break
    }
    return changed / Math.max(1, line.length)
  }
  // The least share of the pair changed, as their counts alone tell: the diff can only find more.
  const floor = (i, j, most = Infinity) => (reads[0][i] === null || reads[1][j] === null ? Infinity
    : Math.min(unmatched(counts[0][i], counts[1][j], olds[i], most), unmatched(counts[1][j], counts[0][i], news[j], most)))
  const scripts = new Map()
  const weighed = (i, j) => {
    work += PAIR
    if (floor(i, j, MAX_CHANGED) > MAX_CHANGED) return Infinity
    const [a, b] = [reads[0][i].words, reads[1][j].words]
    const { kept, seen, edits, steps } = common(a, b)
    work += steps
    scripts.set(i * news.length + j, steps)
    if (!seen) return Infinity
    const share = Math.min(1 - kept[0] / Math.max(1, olds[i].length), 1 - kept[1] / Math.max(1, news[j].length))
    if (share <= MAX_CHANGED) return share
    // Any script as short keeps as many words, at most this many characters of them: too few, and no diff marks the pair.
    const most = ((a.length + b.length - edits) / 2) * Math.min(longest[0][i], longest[1][j])
    if (most < (1 - MAX_CHANGED) * Math.min(Math.max(1, olds[i].length), Math.max(1, news[j].length))) return Infinity
    return exactly(i, j)
  }
  // The share as wordRanges finds it, through @preventive/diff, Infinity where it gives no ranges: the script
  // above may keep other words of the same count, so what it rejects is asked here, and what is chosen.
  const exact = new Map()
  const exactly = (i, j) => {
    const key = i * news.length + j
    if (!exact.has(key)) {
      work += EXACT * (reads[0][i].words.length + reads[1][j].words.length) + (scripts.get(key) ?? 0)
      const { share } = wordChanges(reads[0][i], reads[1][j])
      exact.set(key, share <= MAX_CHANGED ? share : Infinity)
    }
    return exact.get(key)
  }
  const shares = new Float64Array(olds.length * news.length).fill(Number.NaN)
  const share = (i, j) => {
    const key = i * news.length + j
    if (Number.isNaN(shares[key])) shares[key] = olds[i] === news[j] ? 0 : weighed(i, j)
    return shares[key]
  }
  // A chosen pair weighed again as wordRanges has it: whether its share changed, or, past the limit, whether
  // it was not weighed so already; and whether a pair is one wordRanges marks, as far as it has been asked.
  const settle = ([i, j]) => {
    const key = i * news.length + j
    if (olds[i] === news[j] || exact.has(key)) return false
    if (work > LIMIT) return true
    const was = shares[key]
    return (shares[key] = exactly(i, j)) !== was
  }
  const confirmed = ([i, j]) => olds[i] === news[j] || exact.get(i * news.length + j) < Infinity
  return { share, floor, settle, confirmed, spent: () => work, charge: (steps) => (work += steps) }
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
function lookedAhead(n, m, { share, floor, spent }) {
  const pairs = []
  for (let i = 0, next = 0; i < n && next < m && spent() <= LIMIT; i++) {
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

// The chosen pairs weighed again as wordRanges has them, and the lines paired
// again where that changed any, till every pair is as wordRanges weighs it;
// past the limit, the pairs it has not confirmed are left out instead.
export function pairLines(olds, news) {
  if (olds.length > MAX_LINES || news.length > MAX_LINES) return []
  const weigh = weigher(olds, news)
  for (;;) {
    const pairs = aligned(olds.length, news.length, weigh) ?? lookedAhead(olds.length, news.length, weigh)
    if (pairs.filter(weigh.settle).length === 0) return pairs
    if (weigh.spent() > LIMIT) return pairs.filter(weigh.confirmed)
  }
}
