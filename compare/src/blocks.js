// Whether a change set takes `before` to `after` as @preventive/diff holds its
// own to, every kept line alike, its terminator with it: renamedDiff's check on
// the blocks it gives, and markedBlocks' test of lines alike.

import { DiffError, formatChangeSet } from '@preventive/diff'
import { checkLineOptions } from './text.js'

export function blocksHold(before, after, blocks, options) {
  const { whitespace, ignoreCase } = checkLineOptions(options)
  try {
    formatChangeSet(before, after, blocks, { format: 'normal', whitespace, ignoreCase })
    return true
  } catch (error) {
    if (error instanceof DiffError) return false
    throw error
  }
}
