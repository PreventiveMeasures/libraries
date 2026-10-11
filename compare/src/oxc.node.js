import { createRequire } from 'node:module'

// oxc-parser and oxc-minify, optional peers of names.js, required on first
// use: compare.js loads neither. One missing is the environment's error,
// thrown as such rather than taken for a text that does not parse.
const require = createRequire(import.meta.url)
let oxc

function load(name) {
  try {
    return require(name)
  } catch (cause) {
    throw new Error(`@preventive/compare/names.js needs the optional '${name}' peer dependency; install it (e.g. \`npm i ${name}\`)`, { cause })
  }
}

export function getOxc() {
  oxc ??= { parseSync: load('oxc-parser').parseSync, minifySync: load('oxc-minify').minifySync }
  return oxc
}
