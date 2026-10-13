import { createRequire } from 'node:module'

// oxc-parser and oxc-minify, optional peers, required on first use; one missing
// is thrown as the environment's error, not taken for a text that won't parse.
// Each is required by its name as written, as a bundler tracing what a server
// needs (Vercel's @vercel/nft) follows no name it would have to work out.
const require = createRequire(import.meta.url)
let oxc, parser

function peer(name, required) {
  try {
    return required()
  } catch (cause) {
    throw new Error(`@preventive/compare needs the optional '${name}' peer dependency; install it (e.g. \`npm i ${name}\`)`, { cause })
  }
}

// The parser alone, for what needs no minifier: a pretty copy's check, a
// declaration file proven to hold types alone.
export const getParser = () => (parser ??= peer('oxc-parser', () => require('oxc-parser')).parseSync)
export const getOxc = () => (oxc ??= { parseSync: getParser(), minifySync: peer('oxc-minify', () => require('oxc-minify')).minifySync })
