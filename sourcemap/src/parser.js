import { getParser } from './oxc.js'

// The errors oxc reports for a parse, but its warnings and advice.
const syntaxErrors = (parsed) => (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

// What oxc reads a file as, by its extension, a bundler's `?query` after it
// aside: the .js family with JSX, React Native's custom, which plain
// JavaScript parses the same under; 'json' for JSON; null for no script.
const LANGUAGES = new Map([['js', 'jsx'], ['mjs', 'jsx'], ['cjs', 'jsx'], ['jsx', 'jsx'], ['ts', 'ts'], ['mts', 'ts'], ['cts', 'ts'], ['tsx', 'tsx'], ['json', 'json']])

export const languageOf = (path) => LANGUAGES.get(/\.([a-z]+)(?:\?.*)?$/iu.exec(path)?.[1].toLowerCase()) ?? null

// `text` parsed in `lang` (languageOf's): { program } from the first parse
// with no errors, or { error } with the first parse's. `unambiguous` takes a
// module by its syntax, as Node does a typeless file; then `commonjs`, which
// takes the top-level `return` CommonJS's wrapper allows. Flow it cannot read.
export function parse(text, lang) {
  const { parseSync } = getParser()
  let error
  for (const sourceType of ['unambiguous', 'commonjs']) {
    let parsed
    try {
      parsed = parseSync(`source.${lang}`, text, { sourceType, lang })
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

// Calls `visit(child, a, b)` on each node directly under `node`, what the
// caller carries down passed along rather than closed over.
export function forEachChild(node, visit, a, b) {
  for (const field of Object.keys(node)) {
    if (field === 'type' || field === 'start' || field === 'end' || field === 'range' || field === 'loc') continue
    const value = node[field]
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item?.type === 'string') visit(item, a, b)
    } else if (typeof value?.type === 'string') {
      visit(value, a, b)
    }
  }
}

// Every node under `node`, depth first, `node` included.
export function walk(node, enter) {
  enter(node)
  forEachChild(node, walk, enter)
}
