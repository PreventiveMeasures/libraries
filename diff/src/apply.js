// A change set applied: what the diff describes, carried out. Keep the lines
// between the blocks, and put each block's replacement where its old lines
// were. That is the whole of it — positions here are exact, because a change
// set is only ever paired with the file it was computed against.
//
// Applying a patch to a file that has since moved on is a different problem
// and not this one: that needs the hunk located rather than trusted, with a
// search outward and a tolerance for context that no longer matches.
//
// The replacement lines come from whichever side has them. A change set from
// the search points into the second file, so `b` supplies them; one read out
// of a diff carries its own, since the diff is the only place they exist.

import { DiffError } from './myers.js'

export function applyChangeSet(a, blocks, b = null) {
  const out = []
  let ai = 0
  for (const { a0, a1, b0, b1, insert } of blocks) {
    if (a0 < ai || a1 < a0 || a1 > a.length) throw new DiffError('a block is out of order or out of range')
    for (; ai < a0; ai++) out.push(a[ai])
    out.push(...replacement({ b0, b1, insert }, b))
    ai = a1
  }
  for (; ai < a.length; ai++) out.push(a[ai])
  return out
}

// What a block puts in: the lines it carries, when it was read out of a
// diff, and otherwise the second file's. A block naming a range the second
// file does not have comes from somewhere this package cannot vouch for, so
// it is refused — `slice` would quietly clip it and hand back a plausible
// wrong answer instead.
function replacement({ b0, b1, insert }, b) {
  if (insert !== undefined) return insert
  if (b === null) throw new DiffError('a block has no replacement lines, and no second file to take them from')
  if (!(b0 >= 0 && b1 >= b0 && b1 <= b.length)) throw new DiffError('a block is out of order or out of range')
  return b.slice(b0, b1)
}
