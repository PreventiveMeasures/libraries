// The whole of producing a diff, for a caller that wants the text: split
// both files, search, render. It does what the pieces behind it do, in the
// order they are meant to be used, and keeps nothing back: `label` goes
// straight to the formatter. The two label lines a diff opens with are the
// caller's to write in front of what comes back — they are a constant, and
// two files that match are no diff at all rather than a header with nothing
// under it.
//
// What it cannot give is the change set itself, to count what changed or to
// render it twice. That is what splitRecords, diffLines and the formatters
// are still for. Everything else is one call.

import { lineComparisonKey, splitRecords } from './compare.js'
import { formatContext, formatNormal, formatUnified } from './format.js'
import { diffLines, sameLines } from './myers.js'

const FORMAT = { unified: formatUnified, context: formatContext }

// -q: whether the two differ at all, which is a question the search does not
// have to be asked. Identical text settles it without looking at lines, and
// anything else by one pass that stops at the first line that differs —
// where a diff would go on to find the shortest way to describe them all.
// Which files they were is not said, because this was never told their names.
const DIFFER = 'Files differ\n'

function brief(a, b, compare) {
  if (a === b) return ''
  const key = lineComparisonKey(compare)
  // With nothing asked of the comparison, text that differs is lines that
  // differ, and the answer is already in hand.
  if (key === null) return DIFFER
  return sameLines(splitRecords(a), splitRecords(b), key) ? '' : DIFFER
}

export function diff(a, b, { format = 'unified', context = 3, label = null, ...compare } = {}) {
  if (format === 'brief') return brief(a, b, compare)
  const from = splitRecords(a), to = splitRecords(b)
  const blocks = diffLines(from, to, compare)
  // Two files the comparison calls the same have no diff.
  if (blocks.length === 0) return ''
  if (format === 'normal') return formatNormal(from, to, blocks)
  return FORMAT[format](from, to, blocks, { context, label })
}
