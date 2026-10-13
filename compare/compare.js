// Two file trees compared the way `git diff -M` compares two commits, built
// on @preventive/diff for what changed inside each file and @exodus/bytes for
// UTF-8. Nothing here reads a disk.

// The trees in, every file that differs out, with what became of it --
// added, deleted, modified, renamed, or changed in type -- and its line
// change set. A tree is tar's entries, as @preventive/archive unpacks them
// or a Vfs yields them, or names taken as keys.
export { compareTrees } from './src/changes.js'

// Those changes as the patch git writes, for git apply or patch to carry out.
export { formatPatch } from './src/patch.js'

// Changed lines read word by word: what changed within a line and which removed
// line was edited into which added one; and whether diff -w hides blanks of
// more than one kind changing.
export { pairLines } from './src/pairs.js'
export { wordRanges } from './src/words.js'
export { hidesMixedWhitespace } from './src/whitespace.js'

// A rename written as `git diff --stat` writes one.
export { renameParts } from './src/paths.js'

// Two trees taken from different roots lined up: the root between them and
// each old path, directory and package directory as the new tree lays it out.
export { layoutDir, layoutPackageDirs, rootLabel, treeLayout } from './src/layout.js'

// Whether a TypeScript text holds types alone, so that Node runs nothing of it,
// as compareTrees stamps a declaration file's change: proven on Node alone, where
// oxc-parser, an optional peer, is loaded on first use.
export { proveTypeOnly } from '#types'

// What a tree that does not hold together is refused with.
export { CompareError } from './src/error.js'
