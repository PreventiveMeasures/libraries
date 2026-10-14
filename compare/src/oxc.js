// oxc-parser and oxc-minify where Node does not run this: their own builds for
// it (WASM, by their `browser` condition), loaded with names.js and pretty.js,
// both, as a module imports what it may use as it loads.
import { minifySync } from 'oxc-minify'
import { parseSync } from 'oxc-parser'

export const getOxc = () => ({ parseSync, minifySync })
export const getParser = () => parseSync
// Loaded with this module already, as the Node twin loads them on first use.
export const loadParser = async () => {}
export const loadOxc = async () => {}
