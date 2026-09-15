// The package's public surface: everything outside `diff/` goes through
// this file, and nothing outside it reaches for a module by name. What is
// listed here is what a caller actually needs — a name absent from it is
// internal, free to move between the modules below without a single edit
// elsewhere. Adding to the surface is deliberate: an export belongs here
// once a caller genuinely needs it, not in advance.
//
// The one thing not here is the colouring rules: reading diff output back
// is the opposite direction from producing it, and a caller that only
// paints text someone else produced should not pull the search in. They
// live at `@preventive/diff/color.js`.
//
// Inside, `diff/` stands alone — node: builtins only, no import reaching
// back out (self-contained.test.js enforces it), and nothing that assumes
// a filesystem, a terminal or a locale of its own.

// Two files in, the diff between them out — the one call for the thing this
// package is named after. `label` names each hunk the way -p does, if a
// caller wants that; the two label lines a diff opens with are the caller's
// to write in front of what comes back, which is what lets everything
// returned here be read back.
export { diff } from './src/diff.js'

// The other direction. `parseDiff` reads a diff — any of the three formats,
// at any width — into the files it names and, for each, the hunks it is
// written in and the change set they describe. `applyChangeSet` carries one
// of those out over a file, which is what the diff was a description of.
export { parseDiff } from './src/parse.js'
export { applyChangeSet } from './src/apply.js'

// What each half throws when it cannot do its job: the search, when its
// change set would not rebuild the second file; the formatters, when what
// they printed does not say what they were given; the reader, when a diff
// cannot be read. None should happen, and each says which promise broke.
export { DiffError } from './src/myers.js'
export { FormatError } from './src/format.js'
export { PatchError } from './src/parse.js'
