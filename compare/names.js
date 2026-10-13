// JavaScript minified on both sides, its renamed names told apart from its
// changes: the old side given the new side's names wherever a minifier
// renamed a variable alike throughout, so that the two then diff as they are.
// Built on oxc-parser and oxc-minify, and oxfmt for renamedDiff, optional
// peers: on Node loaded on first use, elsewhere oxc with this module.
// compare.js loads none. Typed and described in names.d.ts.

// The diff of two such files with renamed names set aside, checked to hide no
// change; and the same for several whitespace settings at once.
export { renamedDiff, renamedDiffs } from './src/names/diff.js'
