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

// Whether a change set found elsewhere, a server's for one, takes one text to
// another, so that a diff drawn from it hides no change.
export { blocksHold } from './src/blocks.js'

// Changed lines read word by word: what changed within a line, which removed
// line was edited into which added one, and whether two differ in short names
// alone; and whether diff -w hides blanks of more than one kind changing.
export { pairLines, renamedAlone, wordRanges } from './src/words.js'
export { hidesMixedWhitespace } from './src/whitespace.js'

// Files paired by path alone, as triage's Compare pairs a bundle's, and a
// rename written as `git diff --stat` writes one.
export { pathRenames, renameParts } from './src/paths.js'

// Two trees taken from different roots lined up: the root between them and
// each old path, directory and package directory as the new tree lays it out.
export { layoutDir, layoutPackageDirs, rootLabel, treeLayout } from './src/layout.js'

// What a tree that does not hold together is refused with.
export { CompareError } from './src/error.js'
