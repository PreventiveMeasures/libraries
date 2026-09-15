// Where a run of changed lines is printed, when it could be printed in more
// than one place. A run bordered by lines equal to its own means the same
// edit wherever it sits along them: in `b b b` becoming `b b`, deleting the
// first line and deleting the last are one deletion described two ways, and
// a search is free to report either. Left alone, two searches that found the
// same edit print different diffs and neither is wrong — so every run is
// moved to one agreed place.
//
// A run [start, end) may move one line later when the line leaving its front
// is the line joining its back, `lines[start] === lines[end]`, and one line
// earlier by that move undone. Repeating it sweeps the run along the equal
// lines bordering it; where the sweep meets another run the two become one
// and sweep on together, which can free the longer run to reach further than
// either reached alone. Those placements are the whole of the run's freedom.
//
// Of them, the run takes the last that sets it opposite a run in the other
// file, so a deletion and an insertion that can be put against each other
// print as one change rather than as two; failing that, the last of all,
// which puts an edit as late as the text allows. A run is moved over lines,
// never added to or taken from, so the change set keeps its size and means
// what it meant.

// The lines the two files keep pair up in order, so a run that follows `k`
// kept lines here is opposite whatever follows `k` kept lines there.
// `facing[k]` is true when that is a run rather than another kept line.
function facingRuns(changed) {
  const facing = []
  for (let i = 0; ;) {
    const from = i
    while (i < changed.length && changed[i]) i++
    facing.push(i > from)
    if (i === changed.length) return facing
    i++
  }
}

export function slideRuns(lines, changed, otherChanged) {
  const n = changed.length
  const facing = facingRuns(otherChanged)
  // `kept` is how many lines this file keeps before `start`, which is what
  // says who the run is opposite.
  let end = 0, kept = 0, start = 0

  const later = () => {
    if (end === n || lines[start] !== lines[end]) return false
    changed[start++] = 0
    changed[end++] = 1
    kept++
    while (end < n && changed[end]) end++
    return true
  }

  const earlier = () => {
    if (start === 0 || lines[start - 1] !== lines[end - 1]) return false
    changed[--start] = 1
    changed[--end] = 0
    kept--
    while (start > 0 && changed[start - 1]) start--
    return true
  }

  for (let i = 0; i < n; i++) {
    if (!changed[i]) { kept++; continue }
    start = i
    for (end = i; end < n && changed[end]; end++) continue

    // Walking the freedom: back to the earliest placement, then forward over
    // all of them. A sweep that swallowed a run leaves a longer one, which
    // may reach back past where the short one stopped, so the pair repeats
    // until the length settles.
    let opposite = -1
    for (let length = -1; length !== end - start;) {
      length = end - start
      while (earlier()) continue
      opposite = facing[kept] ? end : -1
      while (later()) if (facing[kept]) opposite = end
    }
    if (opposite !== -1) for (let back = end - opposite; back > 0; back--) earlier()

    // Everything up to `end` is settled; `kept` already counts past it.
    i = end - 1
  }
}
