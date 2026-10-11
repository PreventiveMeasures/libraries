// Content as @preventive/diff's lines. Text is UTF-8 (lines are strings) with no
// NUL, as deptree's compare command takes it; git only wants no NUL in the
// first 8000 bytes, so a file git diffs as bytes may be binary here.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { changeSet } from '@preventive/diff'

// A link's content is its target, as git stores it; a missing side is empty.
export function textOf(file) {
  if (file === null) return ''
  if (file.type === 'symlink') return file.target.includes('\0') ? undefined : file.target
  if (typeof file.data === 'string') return file.data.includes('\0') ? undefined : file.data
  if (file.data.includes(0)) return undefined
  try {
    return utf8toString(file.data)
  } catch {
    return undefined
  }
}

const WHITESPACE = new Set(['none', 'all', 'change', 'trailing'])

// diff's options for a change set: where a run free to move sits (`slide`),
// and how far into the lines the two files share at either end it may go
// (`horizon`: without limit, as git has it, unless given -- 0 as diff -U0
// has it, the context as -u does); and which lines are the same (-w, -b, -Z
// as `whitespace`; -i).
export function checkLineOptions({ slide = true, horizon = Infinity, whitespace = 'none', ignoreCase = false } = {}) {
  if (typeof slide !== 'boolean') throw new TypeError(`slide must be a boolean, not ${typeof slide}`)
  if (horizon !== Infinity && !(Number.isSafeInteger(horizon) && horizon >= 0)) throw new RangeError(`horizon must be a whole number or Infinity, not ${horizon}`)
  if (!WHITESPACE.has(whitespace)) throw new RangeError(`whitespace must be 'none', 'all', 'change' or 'trailing', not ${whitespace}`)
  if (typeof ignoreCase !== 'boolean') throw new TypeError(`ignoreCase must be a boolean, not ${typeof ignoreCase}`)
  return { slide, horizon, whitespace, ignoreCase }
}

// Binary content has no blocks and no counts, as --numstat prints `-` for it.
export function contentOf(old, fresh, options) {
  const a = textOf(old), b = textOf(fresh)
  if (a === undefined || b === undefined) return { binary: true, blocks: [], insertions: null, deletions: null }
  const blocks = a === b ? [] : changeSet(a, b, options)
  let deletions = 0, insertions = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    deletions += a1 - a0
    insertions += b1 - b0
  }
  return { binary: false, blocks, insertions, deletions }
}
