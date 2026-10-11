// Content as @preventive/diff's lines. Text is UTF-8 (lines are strings) with no
// NUL, as deptree's compare command takes it; git only wants no NUL in the
// first 8000 bytes, so a file git diffs as bytes may be binary here.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { changeSet } from '@preventive/diff'

// A link's content is its target, as git stores it; a missing side is empty.
export function textOf(file) {
  if (file === null) return ''
  if (file.type === 'symlink') return file.target.includes('\0') ? undefined : file.target
  if (file.data.includes(0)) return undefined
  try {
    return utf8toString(file.data)
  } catch {
    return undefined
  }
}

// Binary content has no blocks and no counts, as --numstat prints `-` for it.
export function contentOf(old, fresh) {
  const a = textOf(old), b = textOf(fresh)
  if (a === undefined || b === undefined) return { binary: true, blocks: [], insertions: null, deletions: null }
  const blocks = a === b ? [] : changeSet(a, b)
  let deletions = 0, insertions = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    deletions += a1 - a0
    insertions += b1 - b0
  }
  return { binary: false, blocks, insertions, deletions }
}
