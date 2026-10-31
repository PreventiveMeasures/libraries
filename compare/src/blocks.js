// Whether a change set takes `before` to `after` as @preventive/diff holds its
// own to, every kept line alike, its terminator with it: renamedDiff's check on
// the blocks it gives, and markedBlocks' test of lines alike.

import { checkLineOptions, holds } from './text.js'

export function blocksHold(before, after, blocks, options) {
  return holds(before, after, blocks, checkLineOptions(options))
}
