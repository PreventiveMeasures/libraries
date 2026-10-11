// Two file trees compared the way `git diff -M` compares two commits, built
// on @preventive/diff for what changed inside each file and @exodus/bytes for
// UTF-8. Nothing here reads a disk.

// The trees in, every file that differs out, with what became of it --
// added, deleted, modified, renamed, or changed in type -- and its line
// change set. A tree is tar's entries, as @preventive/archive unpacks them
// or a Vfs yields them.
export { compareTrees } from './src/changes.js'

// Those changes as the patch git writes, for git apply or patch to carry out.
export { formatPatch } from './src/patch.js'

// What a tree that does not hold together is refused with.
export { CompareError } from './src/error.js'
