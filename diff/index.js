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

// A file's text becomes the records diff compares, and `lineComparisonKey`
// turns diff's comparison options into the one thing the search knows about
// them: the string a line reduces to, equal for two lines that count as the
// same line. What a caller does to a file before any of that — deciding it
// is binary, normalising its terminators — is the caller's, and was never
// diff's.
export { lineComparisonKey, splitRecords } from './src/compare.js'

// The search itself. `diffLines` returns a change set — blocks of the first
// file replaced by blocks of the second — and never returns one that does
// not reconstruct the second file; that check is the package's guarantee
// rather than part of its surface, so it stays behind this file, and
// `DiffError` is what it throws. `sameLines` answers "are these equal"
// without a search, which the search cannot do as cheaply: it interns every
// line before it trims the common ends.
//
// Where a run of changed lines could sit in more than one place and mean the
// same edit, it is settled at one of them rather than left wherever the
// search happened to stop, so the same edit always prints the same way. That
// is what diff does for the styles that print context lines and not what it
// does for the normal style, so the two describe different change sets
// wherever a run is free to move: `slide: false` asks for the other one.
export { DiffError, diffLines, sameLines } from './src/myers.js'

// A change set rendered in diff's three output styles. The bytes are held
// against recorded diff output in the tests, so a patch reader that takes
// one takes these. The header lines are the caller's to build — they are
// what names the two files — and `fn` supplies the `-p` function name.
//
// Each of them reads what it printed back before returning it, and throws
// `FormatError` if it does not say what the change set says. That is the
// same bargain the search makes: a guarantee on the data, paid for in one
// linear pass.
export { FormatError, formatContext, formatNormal, formatUnified } from './src/format.js'

// The other direction. `parseDiff` reads a diff back into the files it names
// and, for each, the hunks it is written in and the change set they
// describe; `PatchError` is what it throws at something it cannot read.
// Every style this package prints, it reads.
export { PatchError, parseDiff } from './src/parse.js'

// A change set carried out: the lines between the blocks kept, each block's
// replacement put where its old lines were. Positions are exact — locating a
// hunk in a file that has moved on is patch's problem, and not this. The
// replacement comes from `b`, or from the block itself when it was read out
// of a diff and carries its own.
export { applyChangeSet } from './src/apply.js'
