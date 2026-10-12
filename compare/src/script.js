// One shortest edit script between two lines' words, as a word view reads them:
// what of each line it keeps, and which of its words.

// The words a script keeps, walked back from its end: each step the way the
// script came, as the ends it had reached the step before tell, and the words
// matched along its diagonal since; the shared ends kept outright.
function mark(kept, reached, { first, n, m, low, high, d: edits }) {
  kept.a.fill(1, 0, first).fill(1, n)
  kept.b.fill(1, 0, first).fill(1, m)
  let x = n, y = m
  for (let d = edits; d > 0; d--) {
    const { lo, ends } = reached[d - 1], k = x - y
    const end = (diagonal) => ends[diagonal - lo]
    const down = k === -d || k - 1 < low || (k !== d && k + 1 <= high && end(k - 1) < end(k + 1))
    const from = down ? k + 1 : k - 1
    for (let at = down ? end(from) : end(from) + 1; at < x; at++) kept.a[at] = kept.b[at - k] = 1
    x = end(from)
    y = x - from
  }
  for (let at = first; at < x; at++) kept.a[at] = kept.b[at] = 1
}

// What of each of two lines' words a shortest edit script between them keeps
// (Myers), their shared ends matched outright, less the blanks a word view
// takes into the changes either side of them: each diagonal carries, for each
// side, what its path keeps, the blanks kept since that side last changed, and
// whether nothing but blanks has been kept since. `steps` is the work, the
// diagonals off both middles never walked. Given `kept`, its words the script
// keeps are marked there.
export function scripter(width, lengths, blanks) {
  const at = width + 1, size = 2 * width + 3
  // Per diagonal: where its path ends; what each side keeps and has kept as blanks since it changed (four
  // in a row); and as bits, whether each side has kept only blanks since it changed, and whether any word.
  const counts = new Int32Array(4 * size), ends = new Int32Array(size), flags = new Uint8Array(size)
  return (a, b, kept = null) => {
    let first = 0, same = 0
    for (; first < a.length && first < b.length && a[first] === b[first]; first++) same += lengths[a[first]]
    let m = b.length, n = a.length
    for (; n > first && m > first && a[n - 1] === b[m - 1]; n--, m--) same += lengths[a[n - 1]]
    let steps = a.length + b.length - n - m + 2 * first
    ends[at + 1] = first
    counts.fill(0, 4 * (at + 1), 4 * (at + 2))
    flags[at + 1] = 0
    const high = n - first, low = first - m, reached = kept && []
    for (let d = 0; d <= n + m - 2 * first; d++) {
      const hi = Math.min(d, high), lo = Math.max(-d, low + ((low + d) & 1))
      for (let k = lo; k <= hi; k += 2) {
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
            bits |= 4
          } else {
            bits = 4
          }
        }
        steps += 2 + x - start
        ends[to] = x
        counts[4 * to] = ka
        counts[4 * to + 1] = kb
        counts[4 * to + 2] = pa
        counts[4 * to + 3] = pb
        flags[to] = bits
        if (x >= n && y >= m) {
          if (kept) mark(kept, reached, { first, n, m, low, high, d })
          return { kept: [same + ka, same + kb], seen: same > 0 || (bits & 4) !== 0, steps }
        }
      }
      reached?.push({ lo, ends: ends.slice(at + lo, at + hi + 1) })
    }
    throw new Error('no edit script between two lines')
  }
}

