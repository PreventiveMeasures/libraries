import { splitRecords } from './compare.js'
import { DiffError } from './myers.js'

// Positions are exact, as a change set is only ever paired with the file it was computed against.
// A block's lines are its own `insert`, as read out of a diff, or else taken from `b`.
export function applyRecords(a, blocks, b = null) {
  const pieces = []
  let ai = 0
  for (const block of blocks) {
    const { a0, a1 } = block
    if (a0 < ai || a1 < a0 || a1 > a.length) throw new DiffError('a block is out of order or out of range')
    pieces.push(a.slice(ai, a0), replacement(block, b))
    ai = a1
  }
  pieces.push(a.slice(ai))
  return pieces.flat()
}

// A range `b` does not have is refused, where slice would clip it to a plausible wrong answer
function replacement({ b0, b1, insert }, b) {
  if (insert !== undefined) return insert
  if (b === null) throw new DiffError('a block has no replacement lines, and no second file to take them from')
  if (!(b0 >= 0 && b1 >= b0 && b1 <= b.length)) throw new DiffError('a block is out of order or out of range')
  return b.slice(b0, b1)
}

export const applyChangeSet = (text, blocks) => applyRecords(splitRecords(text), blocks).join('')
