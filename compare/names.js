// JavaScript minified on both sides, its renamed names told apart from its
// changes: the old side given the new side's names wherever a minifier
// renamed a variable alike throughout, so that the two then diff as they are.
// Built on oxc-parser and oxc-minify, optional peers: on Node loaded on first
// use, elsewhere with this module. compare.js loads neither, and has
// markedBlocks, which needs neither. Typed and described in names.d.ts.

// The old text with the new one's names, or why it keeps its own.
export { renameMap } from './src/names/rename.js'

// Whether a renamed text binds every name as the old one does, by oxc's
// minifier: the check renameMap gives no names without.
export { bindsAlike } from './src/names/binds.js'
