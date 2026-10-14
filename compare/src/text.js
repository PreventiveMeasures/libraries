// Content as @preventive/diff's lines. Text is UTF-8 (lines are strings) with no
// NUL, as deptree's compare command takes it; git only wants no NUL in the
// first 8000 bytes, so a file git diffs as bytes may be binary here.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { changeSet } from '@preventive/diff'

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

// The shortest diff where its cost allows, as --minimal has it; past that the
// search's cutoff, which can face a run with lines alike far from its own: old
// code that new code now comes before, faced with its braces. The search's work
// grows as the square of the lines it changes: at most the quick diff's, or one
// minding blanks and case, which changes no fewer. It may cost 2e8, or 10,000 a
// line of the two texts, as their lines cost already to read.
const SHORTEST_A_LINE = 1e4, SHORTEST_COST = 2e8
const lineCount = (text) => text.split('\n').length
const changes = (blocks) => blocks.reduce((n, { a0, a1, b0, b1 }) => n + a1 - a0 + b1 - b0, 0)
export function shortestChangeSet(a, b, options, lines = lineCount(a) + lineCount(b)) {
  const budget = Math.max(SHORTEST_COST, SHORTEST_A_LINE * lines), quick = changeSet(a, b, options)
  let changed = changes(quick)
  const strict = (options.whitespace ?? 'none') === 'none' && !options.ignoreCase
  if (changed ** 2 > budget && !strict) changed = Math.min(changed, changes(changeSet(a, b, { ...options, ignoreCase: false, whitespace: 'none' })))
  return changed ** 2 > budget ? quick : changeSet(a, b, { ...options, minimal: true })
}

// Binary content has no blocks and no counts, as --numstat prints `-` for it.
export function contentOf(old, fresh, options) {
  const a = textOf(old), b = textOf(fresh)
  if (a === undefined || b === undefined) return { binary: true, blocks: [], insertions: null, deletions: null }
  const blocks = a === b ? [] : changeSet(a, b, options)
  const lines = (from, to) => blocks.reduce((n, block) => n + block[to] - block[from], 0)
  return { binary: false, blocks, insertions: lines('b0', 'b1'), deletions: lines('a0', 'a1') }
}
