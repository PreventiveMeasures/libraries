import { createRequire } from 'node:module'

// oxc-parser and oxc-minify, optional peers, required on first use; one missing
// is thrown as the environment's error, not taken for a text that won't parse.
const require = createRequire(import.meta.url)
let oxc

function load(name) {
  try {
    return require(name)
  } catch (cause) {
    throw new Error(`@preventive/compare/names.js needs the optional '${name}' peer dependency; install it (e.g. \`npm i ${name}\`)`, { cause })
  }
}

export const getOxc = () => (oxc ??= { parseSync: load('oxc-parser').parseSync, minifySync: load('oxc-minify').minifySync })
