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

// Two files in, the diff between them out. What a caller wanting the text
// and not the parts needs, and the only call it needs; `header` and
// `hunkLabel` go straight to the formatter, so nothing below is out of its
// reach but the change set itself.
export { diff } from './src/diff.js'

// A file's text becomes the records diff compares: one line each, its
// terminator kept, because a last line without one is a different line from
// a complete one and that is the whole of how a diff says so. What a caller
// does to a file before that — deciding it is binary, normalising its
// terminators — is the caller's, and was never diff's.
export { splitRecords } from './src/compare.js'

// The search itself. `diffLines` returns a change set — blocks of the first
// file replaced by blocks of the second — and never returns one that does
// not reconstruct the second file; that check is the package's guarantee
// rather than part of its surface, so it stays behind this file, and
// `DiffError` is what it throws. Two files that are the same come back as an
// empty change set without the search being run at all, so asking is cheap
// and there is nothing separate to ask.
//
// Where a run of changed lines could sit in more than one place and mean the
// same edit, it is settled at one of them rather than left wherever the
// search happened to stop, so the same edit always prints the same way. That
// is what diff does for the styles that print context lines and not what it
// does for the normal style, so the two describe different change sets
// wherever a run is free to move: `slide: false` asks for the other one.
export { DiffError, diffLines } from './src/myers.js'

// A change set rendered in diff's three output styles. The bytes are held
// against recorded diff output in the tests, so a patch reader that takes
// one takes these. Two headers are the caller's to build: `header`, the two
// label lines naming the files, and `hunkLabel`, what each hunk's own header
// line carries after its ranges.
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
