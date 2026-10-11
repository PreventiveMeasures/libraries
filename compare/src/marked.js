// The blocks of the diff of two texts whose lines differ in names renamed
// alone: those whose old lines, as `given` has them (the old text with the
// new side's names, line for line, as renameMap gives it), are their new
// lines, alike as the diff has lines alike. None (null) where `given` has
// other lines than the old text.

import { changeSet } from '@preventive/diff'
import { blocksHold } from './blocks.js'
import { checkLineOptions } from './text.js'

// Records as the diff has them, each with its terminator.
const records = (text) => (text === '' ? [] : text.split(/(?<=\n)/u))

export function markedBlocks(before, given, after, options) {
  const lineOptions = checkLineOptions(options)
  const renamed = records(given)
  if (renamed.length !== records(before).length) return null
  // Lines alike are those a change set of no block takes from one to the other.
  const alike = (olds, news) => blocksHold(olds.join(''), news.join(''), [], lineOptions)
  return changeSet(before, after, lineOptions)
    .filter(({ a0, a1, b0, b1, insert }) => a1 - a0 === b1 - b0 && alike(renamed.slice(a0, a1), insert))
    .map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }))
}
