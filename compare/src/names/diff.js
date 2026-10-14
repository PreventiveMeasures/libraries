// A diff of a file minified on both sides with renamed names set aside: the
// old side renamed, formatted again where that changes its layout alone and
// still binds alike, diffed at its shortest where affordable, and the diff
// checked to hide no change.

import { blocksHold } from '../blocks.js'
import { markedBlocks } from '../marked.js'
import { format } from '../pretty.js'
import { checkLineOptions, shownChangeSet } from '../text.js'
import { bindsAlike } from './binds.js'
import { renameMap } from './rename.js'

const ranges = ({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })

// The same, diffed once for each whitespace setting given, in order: the names
// found and the old side given them once for all.
export async function renamedDiffs(before, after, { extension = 'js', otherExtension = extension, whitespace = ['none'] } = {}) {
  if (!Array.isArray(whitespace)) throw new TypeError(`whitespace must be an array, not ${typeof whitespace}`)
  const settings = whitespace.map((setting) => checkLineOptions({ horizon: 0, whitespace: setting }))
  const warnings = []
  const mapped = renameMap(before, after, { extension, otherExtension })
  if (mapped.invariant) warnings.push(`a rename map check failed: ${mapped.invariant}`)
  let renamed = before
  if (!mapped.reason) {
    // A name's new length may move the lines it is on.
    const formatted = await format(mapped.text, extension)
    const read = 'code' in formatted && bindsAlike(before, formatted.code, mapped.kind)
    if ('code' in formatted && !read) warnings.push("the renamed old side, formatted, read otherwise")
    renamed = read ? formatted.code : mapped.text
  }
  let unmarked = false
  const diffs = settings.map((options) => {
    const blocks = shownChangeSet(renamed, after, options).map(ranges)
    if (!blocksHold(renamed, after, blocks, options)) throw new Error('change blocks that do not take the old side to the new')
    // Read off the renamed text before formatting, line for line the old side's.
    const marks = mapped.reason ? [] : markedBlocks(before, mapped.text, after, options)
    unmarked ||= marks === null
    return { whitespace: options.whitespace, blocks, marks: marks ?? [] }
  })
  if (unmarked) warnings.push('a renamed text with lines the old one does not have; none marked')
  return { before: renamed, reason: mapped.reason ?? null, reads: mapped.reads ?? [], diffs, warnings }
}

export async function renamedDiff(before, after, { whitespace = 'none', ...options } = {}) {
  const { before: renamed, reason, reads, diffs: [{ blocks, marks }], warnings } = await renamedDiffs(before, after, { ...options, whitespace: [whitespace] })
  return { before: renamed, blocks, reason, reads, marks, warnings }
}
