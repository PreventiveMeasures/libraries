// oxc-parser and oxc-minify where Node does not run this: their own builds for
// it (WASM, by their `browser` condition), loaded with names.js and pretty.js,
// both, as a module imports what it may use as it loads.
import { minifySync } from 'oxc-minify'
import { parseSync } from 'oxc-parser'

export const getOxc = () => ({ parseSync, minifySync })
export const getParser = () => parseSync
