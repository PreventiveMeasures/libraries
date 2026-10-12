// One shortest edit script between two lines' words (Myers): which of them it
// keeps. Where each step's paths end, one per diagonal walked, is kept in one
// row, `reached` telling where a step's run starts and its lowest diagonal.

// Where the path on diagonal `k` ended at a step, as `reached` tells.
const endOf = (ends, { lo, start }, k) => ends[start + (k - lo) / 2]

// The diagonal a script reaches diagonal `k` from at step `d`: of those either
// side, the one whose path ends further on, as the step before tells.
function from(k, d, { low, high }, ends, before) {
  return k === -d || k - 1 < low || (k !== d && k + 1 <= high && endOf(ends, before, k - 1) < endOf(ends, before, k + 1)) ? k + 1 : k - 1
}

// The words a script keeps, walked back from its end; the shared ends kept outright.
function mark(kept, ends, reached, { first, n, m, d: edits, ...bounds }) {
  kept.a.fill(1, 0, first).fill(1, n)
  kept.b.fill(1, 0, first).fill(1, m)
  let x = n, y = m
  for (let d = edits; d > 0; d--) {
    const k = x - y
    const back = from(k, d, bounds, ends, reached[d]), end = endOf(ends, reached[d], back)
    for (let at = back > k ? end : end + 1; at < x; at++) kept.a[at] = kept.b[at - k] = 1
    x = end
    y = x - back
  }
  for (let at = first; at < x; at++) kept.a[at] = kept.b[at] = 1
}

// The words of each of two lines the script keeps, marked in `kept`, their
// shared ends matched outright; and the work it took, the diagonals off both
// middles never walked, each word read twice over to mark and range it.
export function script(a, b, kept) {
  let first = 0, m = b.length, n = a.length, steps = 2 * (n + m)
  while (first < n && first < m && a[first] === b[first]) first++
  while (n > first && m > first && a[n - 1] === b[m - 1]) {
    n--
    m--
  }
  const bounds = { high: n - first, low: first - m }, ends = [first], reached = [{ lo: 1, start: 0 }]
  for (let d = 0; d <= bounds.high - bounds.low; d++) {
    const before = reached[d], hi = Math.min(d, bounds.high), lo = Math.max(-d, bounds.low + ((bounds.low + d) & 1))
    reached.push({ lo, start: ends.length })
    for (let k = lo; k <= hi; k += 2) {
      const back = from(k, d, bounds, ends, before), end = endOf(ends, before, back)
      let x = back > k ? end : end + 1
      const start = x
      while (x < n && x - k < m && a[x] === b[x - k]) x++
      steps += 2 + x - start
      ends.push(x)
      if (x >= n && x - k >= m) {
        mark(kept, ends, reached, { first, n, m, d, ...bounds })
        return steps
      }
    }
  }
  throw new Error('no edit script between two lines')
}
