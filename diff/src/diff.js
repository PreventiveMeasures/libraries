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

import { splitRecords } from './compare.js'
import { formatContext, formatNormal, formatUnified } from './format.js'
import { diffLines } from './myers.js'

const FORMAT = { unified: formatUnified, context: formatContext }

export function diff(a, b, { format = 'unified', context = 3, label = null, ...compare } = {}) {
  const from = splitRecords(a), to = splitRecords(b)
  const blocks = diffLines(from, to, compare)
  // Two files the comparison calls the same have no diff.
  if (blocks.length === 0) return ''
  if (format === 'normal') return formatNormal(from, to, blocks)
  return FORMAT[format](from, to, blocks, { context, label })
}
