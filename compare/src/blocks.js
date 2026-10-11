// Whether a change set found elsewhere, a server's say, takes `before` to
// `after` as @preventive/diff holds its own to: every kept line alike, its
// terminator with it. Anything that is not a list of ranges is refused.

import { DiffError, formatChangeSet } from '@preventive/diff'
import { checkLineOptions } from './text.js'

const isBlock = (block) => block !== null && typeof block === 'object' && ['a0', 'a1', 'b0', 'b1'].every((end) => Number.isSafeInteger(block[end]) && block[end] >= 0)

export function blocksHold(before, after, blocks, options) {
  const { whitespace, ignoreCase } = checkLineOptions(options)
  if (!Array.isArray(blocks) || !blocks.every(isBlock)) return false
  try {
    formatChangeSet(before, after, blocks, { format: 'normal', whitespace, ignoreCase })
    return true
  } catch (error) {
    if (error instanceof DiffError) return false
    throw error
  }
}
