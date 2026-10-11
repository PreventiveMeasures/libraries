// The blocks of the diff of `before` and `after` whose old lines, as `given`
// (`before` renamed, line for line) has them, are their new lines: changed in
// renamed names alone. null where `given` has another number of lines.

import { changeSet } from '@preventive/diff'
import { blocksHold } from './blocks.js'
import { checkLineOptions } from './text.js'

const records = (text) => (text === '' ? [] : text.split(/(?<=\n)/u))

export function markedBlocks(before, given, after, options) {
  const lineOptions = checkLineOptions(options)
  const renamed = records(given)
  if (renamed.length !== records(before).length) return null
  // Lines alike are those an empty change set takes from one to the other.
  const alike = (olds, news) => blocksHold(olds.join(''), news.join(''), [], lineOptions)
  return changeSet(before, after, lineOptions)
    .filter(({ a0, a1, b0, b1, insert }) => a1 - a0 === b1 - b0 && alike(renamed.slice(a0, a1), insert))
    .map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }))
}
