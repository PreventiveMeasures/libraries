// The whole of producing a diff, for a caller that wants the text: split
// both files, search, render. It does what the pieces behind it do, in the
// order they are meant to be used, and keeps nothing back: `label` goes
// straight to the formatter. The two label lines a diff opens with are the
// caller's to write in front of what comes back -- they are a constant, and
// two files that match are no diff at all rather than a header with nothing
// under it.
//
// What it cannot give is the change set itself, to count what changed or to
// render it twice. `changeSet` gives that, in the shape parseDiff reads one
// out of a diff, and `formatChangeSet` prints one. Everything else is one call.

import { lineComparisonKey, splitRecords } from './compare.js'
import { formatContext, formatNormal, formatUnified } from './format.js'
import { diffLines, sameLines, verifyChangeSet } from './myers.js'

const FORMAT = { unified: formatUnified, context: formatContext, normal: formatNormal }

// -q: whether the two differ at all, which is a question the search does not
// have to be asked. Identical text settles it without looking at lines, and
// anything else by one pass that stops at the first line that differs --
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

// A number of lines: a whole one, or Infinity for all there are. The search
// is bounded by it, so anything else is refused before it gets there.
function lineCount(value, name) {
  if (!(Number.isInteger(value) && value >= 0) && value !== Infinity) throw new RangeError(`${name} is a number of lines, not ${value}`)
  return value
}

// The change set `diff` prints, without printing it: the blocks of the first
// file replaced by blocks of the second, each holding the lines it removes
// and inserts, as a block read out of a diff does. A run free to sit in more
// than one place sits where `diff` puts it with three lines of context;
// `horizon` is the context to match instead (0 for the normal format), or
// Infinity to let every run go as far as it can, as git does. `discard:
// false` has the search take every line, keeping its cutoff, where diff
// would set some aside first (myers.js) and git sets aside others.
// With nothing asked of the comparison, applyChangeSet over the first file
// gives back the second.
export function changeSet(a, b, { slide = true, horizon = 3, ...comparison } = {}) {
  const from = splitRecords(a), to = splitRecords(b)
  return diffLines(from, to, { ...comparison, slide, horizon: lineCount(horizon, 'horizon') }).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1, remove: from.slice(a0, a1), insert: to.slice(b0, b1) }))
}

// A change set already in hand, printed as `diff` prints the one it finds,
// with no search. It comes from the caller, so it is held to what the
// search's own is held to before a line is printed: carried out over the
// first file, under the comparison given, it has to give the second.
export function formatChangeSet(a, b, blocks, { format = 'unified', context = 3, label = null, ...comparison } = {}) {
  if (!Object.hasOwn(FORMAT, format)) throw new RangeError(`a change set prints as unified, context or normal, not ${format}`)
  const from = splitRecords(a), to = splitRecords(b)
  verifyChangeSet(from, to, blocks, lineComparisonKey(comparison))
  if (blocks.length === 0) return ''
  return FORMAT[format](from, to, blocks, { context, label })
}

export function diff(a, b, { format = 'unified', context = 3, label = null, ...compare } = {}) {
  if (format === 'brief') return brief(a, b, compare)
  const from = splitRecords(a), to = splitRecords(b)
  // A run of changes that could sit in more than one place is settled in
  // every format, but may move into what the two files share at either end
  // only as far as the context lines printed there, or `horizon` if that is
  // more -- as diff does, which is why `diff` and `-U0` can agree with each
  // other and not with `-u`. The normal format prints no context.
  const { slide = true, horizon = 0, ...comparison } = compare
  const reach = lineCount(horizon, 'horizon')
  const blocks = diffLines(from, to, { ...comparison, slide, horizon: format === 'normal' ? reach : Math.max(reach, lineCount(context, 'context')) })
  // Two files the comparison calls the same have no diff.
  if (blocks.length === 0) return ''
  return FORMAT[format](from, to, blocks, { context, label })
}
