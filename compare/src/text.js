// A file's content as lines, which is where this package stands on
// @preventive/diff: whatever a change did to a file's text, diff's change
// set says line by line.
//
// Text is UTF-8 with no NUL in it, as deptree takes a patch's files. git asks
// less -- no NUL among the first 8000 bytes -- and diffs the rest as bytes;
// lines here are strings, and bytes that are not UTF-8 have no string to be,
// so such a file is binary here where git would print its lines.

import { changeSet } from '@preventive/diff'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A side's content as text, or undefined where it is not text. A link's is
// its target, which is what git stores for one; no side at all is empty.
export function textOf(file) {
  if (file === null) return ''
  if (file.type === 'symlink') return file.target.includes('\0') ? undefined : file.target
  if (file.data.includes(0)) return undefined
  try {
    return decoder.decode(file.data)
  } catch {
    return undefined
  }
}

// What a change did to the content, as `git diff --numstat` counts it: the
// lines removed and inserted, and the change set that removes and inserts
// them. Binary content has no lines, and no counts, which numstat prints as
// `-`.
export function contentOf(old, fresh) {
  const a = textOf(old), b = textOf(fresh)
  if (a === undefined || b === undefined) return { binary: true, blocks: [], insertions: null, deletions: null }
  const blocks = changeSet(a, b)
  let deletions = 0, insertions = 0
  for (const { a0, a1, b0, b1 } of blocks) {
    deletions += a1 - a0
    insertions += b1 - b0
  }
  return { binary: false, blocks, insertions, deletions }
}
