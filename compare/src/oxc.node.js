import { createRequire } from 'node:module'

// oxc-parser and oxc-minify, optional peers, loaded on first use; one missing
// is thrown as the environment's error, not taken for a text that won't parse.
// Both are ES modules, which require() loads only where the runtime lets it
// (Vercel's does not), so a step that can wait for them imports them first
// (format, renamedDiffs); one that cannot, a declaration file's proof, requires
// them. Each is named as written, as a bundler tracing what a server needs
// (Vercel's @vercel/nft) follows no name it would have to work out.
const require = createRequire(import.meta.url)
let minifier, parser

const missing = (name, cause) => new Error(`@preventive/compare needs the optional '${name}' peer dependency; install it (e.g. \`npm i ${name}\`)`, { cause })

function required(name, load) {
  try {
    return load()
  } catch (cause) {
    throw missing(name, cause)
  }
}

export async function loadParser() {
  parser ??= (await import('oxc-parser').catch((cause) => { throw missing('oxc-parser', cause) })).parseSync
}

export async function loadOxc() {
  await loadParser()
  minifier ??= (await import('oxc-minify').catch((cause) => { throw missing('oxc-minify', cause) })).minifySync
}

// The parser alone, for what needs no minifier: a pretty copy's check, a
// declaration file proven to hold types alone.
export const getParser = () => (parser ??= required('oxc-parser', () => require('oxc-parser')).parseSync)
export const getOxc = () => ({ parseSync: getParser(), minifySync: (minifier ??= required('oxc-minify', () => require('oxc-minify')).minifySync) })
