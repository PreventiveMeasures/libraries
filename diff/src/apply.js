import { splitRecords } from './compare.js'
import { DiffError } from './myers.js'

// Positions are exact, as a change set is only ever paired with the file it was computed against
export function applyRecords(a, blocks) {
  const pieces = []
  let ai = 0
  for (const { a0, a1, insert } of blocks) {
    if (a0 < ai || a1 < a0 || a1 > a.length) throw new DiffError('a block is out of order or out of range')
    if (!Array.isArray(insert)) throw new DiffError('a block has no lines to insert')
    pieces.push(a.slice(ai, a0), insert)
    ai = a1
  }
  pieces.push(a.slice(ai))
  return pieces.flat()
}

export const applyChangeSet = (text, blocks) => applyRecords(splitRecords(text), blocks).join('')
