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

// A file's text becomes the records diff compares, and `lineKey` says when
// two of them count as the same line — the whitespace and case options,
// expressed as the string GNU would have hashed. The other two are the
// decisions taken before the split: whether the file is binary at all, and
// `--strip-trailing-cr`, which edits the text so the output shows it too.
export { isBinary, lineKey, splitRecords, stripTrailingCr } from './src/compare.js'

// The search itself. `diffLines` returns a change set — blocks of the first
// file replaced by blocks of the second — and never returns one that does
// not reconstruct the second file: `verifyChangeSet` is that check, exported
// so a change set from anywhere else can be held to the same bar, and
// `DiffError` is what both throw. `sameLines` answers "are these equal"
// without a search.
export { DiffError, diffLines, sameLines, verifyChangeSet } from './src/myers.js'

// A change set rendered in diff's three output styles, byte for byte as GNU
// renders it. The header lines are the caller's to build — they are what
// names the two files — and `fn` supplies the `-p` function name.
export { formatContext, formatNormal, formatUnified } from './src/format.js'

// What the two context styles are assembled from, for a caller that wants
// the hunks rather than the text: `groupHunks` is the split into hunks,
// `functionLine` the `-p` name a hunk falls under.
export { functionLine, groupHunks } from './src/hunks.js'

// A file name as a header prints it: bare when it can be, C-quoted when it
// cannot.
export { quoteHeaderName } from './src/quote.js'
