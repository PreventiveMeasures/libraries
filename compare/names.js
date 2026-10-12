// JavaScript minified on both sides, its renamed names told apart from its
// changes: the old side given the new side's names wherever a minifier
// renamed a variable alike throughout, so that the two then diff as they are.
// Built on oxc-parser and oxc-minify, and oxfmt for renamedDiff, optional
// peers: on Node loaded on first use, elsewhere oxc with this module.
// compare.js loads none, and has markedBlocks, which needs none. Typed and
// described in names.d.ts.

// The old text with the new one's names, or why it keeps its own.
export { renameMap } from './src/names/rename.js'

// Whether a renamed text binds every name as the old one does, by oxc's
// minifier: the check renameMap gives no names without.
export { bindsAlike } from './src/names/binds.js'

// The diff of two such files with renamed names set aside, checked to hide no
// change: renameMap, formatChecked and the diff in one call.
export { renamedDiff } from './src/names/diff.js'
