// A diff of a file minified on both sides with renamed names set aside: the
// old side renamed, line for line the old side's, diffed at its shortest where
// affordable, and the diff checked to hide no change.

import { blocksHold } from '../blocks.js'
import { markedBlocks } from '../marked.js'
import { checkLineOptions, shownChangeSet } from '../text.js'
import { renameMap } from './rename.js'

const ranges = ({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })

// The same, diffed once for each whitespace setting given, in order: the names
// found and the old side given them once for all.
function diffsOf(before, after, { extension = 'js', otherExtension = extension, whitespace = ['none'] } = {}) {
  if (!Array.isArray(whitespace)) throw new TypeError(`whitespace must be an array, not ${typeof whitespace}`)
  const settings = whitespace.map((setting) => checkLineOptions({ horizon: 0, whitespace: setting }))
  const warnings = []
  const mapped = renameMap(before, after, { extension, otherExtension })
  if (mapped.invariant) warnings.push(`a rename map check failed: ${mapped.invariant}`)
  // Not formatted again: its lines are the old side's, each where it was, and
  // formatting a formatted text lays it out other than the new side was.
  const renamed = mapped.reason ? before : mapped.text
  let unmarked = false
  const diffs = settings.map((options) => {
    const blocks = shownChangeSet(renamed, after, options).map(ranges)
    if (!blocksHold(renamed, after, blocks, options)) throw new Error('change blocks that do not take the old side to the new')
    // The plain diff's blocks the renamed text, line for line the old side's, says differ in names alone.
    const marks = mapped.reason ? [] : markedBlocks(before, mapped.text, after, options)
    unmarked ||= marks === null
    return { whitespace: options.whitespace, blocks, marks: marks ?? [] }
  })
  if (unmarked) warnings.push('a renamed text with lines the old one does not have; none marked')
  return { before: renamed, reason: mapped.reason ?? null, reads: mapped.reads ?? [], diffs, warnings }
}

// A promise still, as callers await it: what goes wrong rejects it.
export function renamedDiffs(before, after, options) {
  return new Promise((resolve) => {
    resolve(diffsOf(before, after, options))
  })
}

export async function renamedDiff(before, after, { whitespace = 'none', ...options } = {}) {
  const { before: renamed, reason, reads, diffs: [{ blocks, marks }], warnings } = await renamedDiffs(before, after, { ...options, whitespace: [whitespace] })
  return { before: renamed, blocks, reason, reads, marks, warnings }
}
