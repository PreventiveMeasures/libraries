import { lineComparisonKey, splitRecords } from './compare.js'
import { formatContext, formatNormal, formatUnified } from './format.js'
import { diffLines, sameLines, verifyChangeSet } from './myers.js'

const FORMAT = { unified: formatUnified, context: formatContext, normal: formatNormal }

function printer(format) {
  if (!Object.hasOwn(FORMAT, format)) throw new RangeError(`a change set prints as unified, context or normal, not ${format}`)
  return FORMAT[format]
}

// The search is bounded by it, so it is refused before it gets there
function lineCount(value, name) {
  if (!(Number.isInteger(value) && value >= 0) && value !== Infinity) throw new RangeError(`${name} is a number of lines, not ${value}`)
  return value
}

// -q, with no search: identical text, or one pass to the first line that differs.
// Which files differ is not said, as this was never told their names.
function brief(a, b, comparison) {
  if (a === b) return ''
  const key = lineComparisonKey(comparison)
  return key === null || !sameLines(splitRecords(a), splitRecords(b), key) ? 'Files differ\n' : ''
}

export function diff(a, b, { format = 'unified', context = 3, label = null, horizon = 0, ...options } = {}) {
  if (format === 'brief') return brief(a, b, options)
  const print = printer(format)
  const from = splitRecords(a), to = splitRecords(b)
  // A run slides into the shared ends only as far as the context printed there, or `horizon` if more,
  // as diff does: why `diff` and `-U0` can agree where `-u` does not
  const reach = format === 'normal' ? lineCount(horizon, 'horizon') : Math.max(lineCount(horizon, 'horizon'), lineCount(context, 'context'))
  return print(from, to, diffLines(from, to, { ...options, horizon: reach }), { context, label })
}

export function changeSet(a, b, { horizon = 3, ...options } = {}) {
  const from = splitRecords(a), to = splitRecords(b)
  return diffLines(from, to, { ...options, horizon: lineCount(horizon, 'horizon') })
    .map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1, remove: from.slice(a0, a1), insert: to.slice(b0, b1) }))
}

// A caller's change set is held to what the search's own is held to before a line is printed
export function formatChangeSet(a, b, blocks, { format = 'unified', context = 3, label = null, ...comparison } = {}) {
  const print = printer(format)
  const from = splitRecords(a), to = splitRecords(b)
  verifyChangeSet(from, to, blocks, lineComparisonKey(comparison))
  return print(from, to, blocks, { context, label })
}
