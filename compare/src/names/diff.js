// A diff of a file minified on both sides with renamed names set aside: the
// old side renamed, formatted again where that changes its layout alone and
// still binds alike, diffed, and the diff checked to hide no change.

import { changeSet } from '@preventive/diff'
import { blocksHold } from '../blocks.js'
import { markedBlocks } from '../marked.js'
import { formatChecked } from '../pretty.js'
import { bindsAlike } from './binds.js'
import { renameMap } from './rename.js'

const ranges = ({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })

export async function renamedDiff(before, after, { extension = 'js', otherExtension = extension, whitespace = 'none' } = {}) {
  const warnings = []
  const mapped = renameMap(before, after, { extension, otherExtension })
  if (mapped.invariant) warnings.push(`a rename map check failed: ${mapped.invariant}`)
  let renamed = before
  if (!mapped.reason) {
    // A name's new length may move the lines it is on.
    const formatted = await formatChecked(mapped.text, extension)
    const read = 'code' in formatted && bindsAlike(before, formatted.code, mapped.kind)
    if ('code' in formatted && !read) warnings.push("the renamed old side, formatted, read otherwise")
    renamed = read ? formatted.code : mapped.text
  }
  const options = { horizon: 0, whitespace }
  const blocks = changeSet(renamed, after, options).map(ranges)
  if (!blocksHold(renamed, after, blocks, options)) throw new Error('change blocks that do not take the old side to the new')
  // Read off the renamed text before formatting, line for line the old side's.
  const marks = mapped.reason ? [] : markedBlocks(before, mapped.text, after, options)
  if (marks === null) warnings.push('a renamed text with lines the old one does not have; none marked')
  return { before: renamed, blocks, reason: mapped.reason ?? null, reads: mapped.reads ?? [], marks: marks ?? [], warnings }
}
