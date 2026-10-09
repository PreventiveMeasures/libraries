import { createRequire } from 'node:module'

// oxc-parser, an optional peer dependency, required lazily as stasis does:
// reading a map never loads the native parser, only finding edges does. A
// missing one is the environment's error, not a file's, so it is thrown with
// an install hint rather than recorded as a file that would not parse.
let parser
function getParser() {
  if (parser) return parser
  try {
    parser = createRequire(import.meta.url)('oxc-parser')
  } catch (cause) {
    throw new Error("@preventive/sourcemap/edges.js needs the optional 'oxc-parser' peer dependency; install it (e.g. `npm i oxc-parser`)", { cause })
  }
  return parser
}

// The errors oxc reports for a parse, but its warnings and advice.
const syntaxErrors = (parsed) => (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

const JS_FAMILY = /\.[cm]?js$/u

// `text` parsed as `name`, oxc reading JS, TS, JSX or TSX from its
// extension: { program } from the first parse with no errors, or { error }
// with the first parse's. `unambiguous` takes a module by its syntax, as
// Node does a typeless file; then JSX in a .js file, React Native's custom;
// then `commonjs`, which takes the top-level `return` CommonJS's wrapper
// allows. Flow it cannot read.
export function parse(name, text) {
  const { parseSync } = getParser()
  const attempts = [{ sourceType: 'unambiguous' }]
  if (JS_FAMILY.test(name)) attempts.push({ sourceType: 'unambiguous', lang: 'jsx' })
  attempts.push({ sourceType: 'commonjs' })
  let error
  for (const options of attempts) {
    let parsed
    try {
      parsed = parseSync(name, text, options)
    } catch (cause) {
      error ??= cause.message
      continue
    }
    const errors = syntaxErrors(parsed)
    if (errors.length === 0) return { program: parsed.program }
    error ??= errors[0].message
  }
  return { error }
}

// Every node under `node`, depth first, with its parent and the key it
// sits under: `enter` returns false to skip a node's children.
export function walk(node, enter, parent = null, key = null) {
  if (enter(node, parent, key) === false) return
  for (const field of Object.keys(node)) {
    if (field === 'type' || field === 'start' || field === 'end' || field === 'range' || field === 'loc') continue
    const value = node[field]
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item?.type === 'string') walk(item, enter, node, field)
    } else if (value !== null && typeof value?.type === 'string') {
      walk(value, enter, node, field)
    }
  }
}
