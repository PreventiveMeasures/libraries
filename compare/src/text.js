// Content as @preventive/diff's lines. Text is UTF-8 (lines are strings) with no
// NUL, as deptree's compare command takes it; git only wants no NUL in the
// first 8000 bytes, so a file git diffs as bytes may be binary here.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { DiffError, changeSet, formatChangeSet } from '@preventive/diff'

// A link's content is its target, as git stores it; a missing side is empty.
export function textOf(file) {
  if (file === null) return ''
  const content = file.type === 'symlink' ? file.target : file.data
  if (typeof content === 'string') return content.includes('\0') ? undefined : content
  if (content.includes(0)) return undefined
  try {
    return utf8toString(content)
  } catch {
    return undefined
  }
}

const WHITESPACE = new Set(['none', 'all', 'change', 'trailing'])

// diff's options for a change set: how far into the lines the two files share
// at either end a run free to move may go (`horizon`: without limit, as git
// has it, unless given -- 0 as diff -U0 has it, the context as -u does); and
// which lines are the same (-w, -b, -Z as `whitespace`; -i).
export function checkLineOptions({ horizon = Infinity, whitespace = 'none', ignoreCase = false } = {}) {
  if (horizon !== Infinity && !(Number.isSafeInteger(horizon) && horizon >= 0)) throw new RangeError(`horizon must be a whole number or Infinity, not ${horizon}`)
  if (!WHITESPACE.has(whitespace)) throw new RangeError(`whitespace must be 'none', 'all', 'change' or 'trailing', not ${whitespace}`)
  if (typeof ignoreCase !== 'boolean') throw new TypeError(`ignoreCase must be a boolean, not ${typeof ignoreCase}`)
  return { horizon, whitespace, ignoreCase }
}

const changes = (blocks) => blocks.reduce((n, { a0, a1, b0, b1 }) => n + a1 - a0 + b1 - b0, 0)
const records = (text) => (text === '' ? [] : text.split(/(?<=\n)/u))
const minding = (options) => ({ ...options, ignoreCase: false, whitespace: 'none' })
const ignoring = (options) => (options.whitespace ?? 'none') !== 'none' || Boolean(options.ignoreCase)

// Ignoring blanks or case keeps every line minding them keeps, so it never
// shows more: past the search's cutoff it may, and then it is the diff minding
// them, its blocks diffed again ignoring them. Where it shows no fewer lines,
// it is that diff, block for block: ignoring them does nothing there.
function noLonger(a, b, options, blocks, minded) {
  const A = records(a), B = records(b)
  const block = (a0, a1, b0, b1) => ({ a0, a1, b0, b1, remove: A.slice(a0, a1), insert: B.slice(b0, b1) })
  const again = minded.flatMap(({ a0, a1, b0, b1 }) => (a0 === a1 || b0 === b1
    ? [block(a0, a1, b0, b1)]
    : changeSet(A.slice(a0, a1).join(''), B.slice(b0, b1).join(''), options).map((part) => block(a0 + part.a0, a0 + part.a1, b0 + part.b0, b0 + part.b1))))
  // Blocks put together from diffs of their own are held to what diff holds its own to.
  const holds = (set) => {
    try {
      formatChangeSet(a, b, set, { format: 'normal', ignoreCase: options.ignoreCase, whitespace: options.whitespace })
      return true
    } catch (error) {
      if (error instanceof DiffError) return false
      throw error
    }
  }
  const best = changes(again) < changes(blocks) && holds(again) ? again : blocks
  return changes(best) < changes(minded) ? best : minded
}

// The diff as diff finds it, ignoring blanks or case never showing more.
export function lineChangeSet(a, b, options) {
  const blocks = changeSet(a, b, options)
  return ignoring(options) ? noLonger(a, b, options, blocks, changeSet(a, b, minding(options))) : blocks
}

// The shortest diff where its cost allows, as --minimal has it; past that the
// search's cutoff, which can face a run with lines alike far from its own: old
// code that new code now comes before, faced with its braces. The search's work
// grows as the square of the lines it changes: at most the quick diff's, or one
// minding blanks and case, which changes no fewer. It may cost 2e8, or 10,000 a
// line of the two texts, as their lines cost already to read.
const SHORTEST_A_LINE = 1e4, SHORTEST_COST = 2e8
const lineCount = (text) => text.split('\n').length
function shortest(a, b, options, lines, bound) {
  const budget = Math.max(SHORTEST_COST, SHORTEST_A_LINE * lines), quick = changeSet(a, b, options)
  let changed = changes(quick)
  if (changed ** 2 > budget) changed = Math.min(changed, bound())
  return changed ** 2 > budget ? quick : changeSet(a, b, { ...options, minimal: true })
}
// For lines read, as names are paired by: ignoring blanks or case, what it
// finds, its lines alike kept where minding them ties.
export function shortestChangeSet(a, b, options, lines = lineCount(a) + lineCount(b)) {
  return shortest(a, b, options, lines, () => (ignoring(options) ? changes(changeSet(a, b, minding(options))) : Infinity))
}
// For lines shown: ignoring blanks or case, never more than minding them.
export function shownChangeSet(a, b, options, lines = lineCount(a) + lineCount(b)) {
  if (!ignoring(options)) return shortestChangeSet(a, b, options, lines)
  const minded = shortestChangeSet(a, b, minding(options), lines)
  return noLonger(a, b, options, shortest(a, b, options, lines, () => changes(minded)), minded)
}

// Binary content has no blocks and no counts, as --numstat prints `-` for it.
export function contentOf(old, fresh, options) {
  const a = textOf(old), b = textOf(fresh)
  if (a === undefined || b === undefined) return { binary: true, blocks: [], insertions: null, deletions: null }
  const blocks = a === b ? [] : lineChangeSet(a, b, options)
  const lines = (from, to) => blocks.reduce((n, block) => n + block[to] - block[from], 0)
  return { binary: false, blocks, insertions: lines('b0', 'b1'), deletions: lines('a0', 'a1') }
}
