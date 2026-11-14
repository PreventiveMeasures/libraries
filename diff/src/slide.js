// A run bordered by lines equal to its own is the same edit wherever it sits along them, so every run is
// moved to one place: the last that sets it opposite a run in the other file, so a deletion and an
// insertion print as one change, or else the last of all. A run is moved over lines, never resized.

// Kept lines pair up in order, so a run after `k` kept lines here faces what follows `k` kept lines there:
// `facing[k]` is whether that is a run
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
  // `kept` counts the lines this file keeps before `start`, which says what the run faces
  let end = 0, kept = 0, start = 0

  // The run [start, end) moves a line later where the line leaving its front is the one joining its back
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

    // Back to the earliest placement, then forward over all of them; a sweep that merged a run may reach
    // further back, so this repeats until the length settles
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
