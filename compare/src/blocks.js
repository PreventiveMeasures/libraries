// A change set found elsewhere -- another process's, a server's -- checked
// before it is drawn, so that a diff drawn from it hides no change.

import { DiffError, formatChangeSet } from '@preventive/diff'
import { checkLineOptions } from './text.js'

const RANGE = ['a0', 'a1', 'b0', 'b1']
const isBlock = (block) => block !== null && typeof block === 'object' && RANGE.every((end) => Number.isSafeInteger(block[end]) && block[end] >= 0)

// Held to what @preventive/diff holds its own search's change set to: carried
// out over `before` under the comparison options, it gives `after`, every line
// between its blocks alike on both sides, a line's terminator with it (a
// newline added or dropped after the last line is that line changed, but
// under the whitespace options). Anything else in hand is refused.
export function blocksHold(before, after, blocks, options) {
  const { whitespace, ignoreCase } = checkLineOptions(options)
  if (!Array.isArray(blocks) || !blocks.every(isBlock)) return false
  try {
    formatChangeSet(before, after, blocks.map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })), { format: 'normal', whitespace, ignoreCase })
    return true
  } catch (error) {
    if (error instanceof DiffError) return false
    throw error
  }
}
