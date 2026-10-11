// Hand-written against compare.js; a change to either belongs with the other.

import type { Block } from '@preventive/diff'

// An entry of a tree, in the shape tar has it: what @preventive/archive's
// unpack returns and Vfs.entries yields are these as they are. `name` is a
// relative path with no empty, `.` or `..` segment, or `.` for the root
// directory. A file is `data` (text is taken as UTF-8) under `mode`, 0o644
// if not given; a symlink's or a hard link's target is `linkname`, a hard
// link's spelled as the name of an entry in the same tree. A directory adds
// nothing, as git keeps none; what is not given a directory entry is implied.
// `data` and `linkname` are read only where the type uses them; a mode given
// is checked on any entry, but only a file's is compared, as only a file's is
// kept by git. A fifo or a device is refused, as is a name or link target
// that is not well-formed Unicode, since git could hold neither.
export interface TreeEntry {
  name: string
  type?: 'file' | 'contiguous-file' | 'directory' | 'symlink' | 'hardlink' | 'fifo' | 'character-device' | 'block-device'
  mode?: number
  linkname?: string
  data?: string | Uint8Array
}

// A file or a link as its tree holds it: what git keeps of one. A hard link
// is a copy of what it names. `data` is the entry's own bytes, not a copy.
export type TreeFile =
  | { path: string; type: 'file'; mode: number; data: Uint8Array }
  | { path: string; type: 'symlink'; target: string }

// git's statuses, A, D, M, R and T.
export type Status = 'added' | 'deleted' | 'modified' | 'renamed' | 'type-changed'

// One path that differs, and what became of it. `old` is null for an added
// file and `new` for a deleted one; a renamed file has both, under their
// two paths. `similarity` is a rename's, as git's similarity index: the
// percentage of the new file the old one accounts for, 100 where the content
// is unchanged; null for anything else.
//
// `blocks` is what happened to the content, as @preventive/diff's change set
// from the old side to the new, where a file's content is its bytes and a
// link's its target, and a side that is not there is empty. `insertions`
// and `deletions` count its lines, as --numstat does. Content is text when
// it is UTF-8 with no NUL; where either side is not, `binary` is true, and
// there are no blocks and no counts.
export interface FileChange {
  status: Status
  old: TreeFile | null
  new: TreeFile | null
  similarity: number | null
  binary: boolean
  blocks: Block[]
  insertions: number | null
  deletions: number | null
}

// `renames` is git's -M: the least similarity, as a percentage above 0, at
// which a deleted file and an added one are one file renamed; `true` is
// git's default of 50, `false` finds none, and 100 only those whose content
// is unchanged. `renamesByPath`, unless false, also takes a deleted file and
// an added one for a rename however little alike, where their paths differ
// only by `lib` for `src` or a TypeScript extension for its JavaScript one
// (`.ts`, `.mts`, `.cts`, `.tsx` for `.js`, `.mjs`, `.cjs`, `.jsx`), or both:
// `lib/a.js` and `src/a.ts`. That gives way only to a candidate that is a
// rename by itself and scores at least halfway from the pair's score to 100%;
// git has no such pass, so false is git's own -M. `renameLimit` is git's
// diff.renameLimit: when more deleted files times added files are left after
// the renames that need no scoring than its square, the rest are not looked
// for. 1000 unless given; Infinity for no limit.
export interface CompareOptions {
  renames?: boolean | number
  renamesByPath?: boolean
  renameLimit?: number
}

// Every path the trees do not have the same, in git's order: by path in code
// point order, a rename at its new one. A file is the same when its bytes
// and its mode are, a link when its target is. Throws a CompareError for a
// tree that does not hold together, naming the path and which tree.
export function compareTrees(a: Iterable<TreeEntry>, b: Iterable<TreeEntry>, options?: CompareOptions): FileChange[]

// The changes as `git diff` writes them, without its `index` lines, with
// `context` lines around each change, 3 unless given. A file's mode is
// written in full, where git would only have 644 or 755.
export function formatPatch(changes: Iterable<FileChange>, options?: { context?: number }): string

// `path` is the name at fault as its entry spelled it, and `tree` which tree
// holds it.
export class CompareError extends Error {
  constructor(detail: string, path?: string, tree?: 'old' | 'new')
  path: string | undefined
  tree: 'old' | 'new' | undefined
}
