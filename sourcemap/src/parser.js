import { getParser } from './oxc.js'

// `unambiguous` takes a module by its syntax, as Node does a typeless file;
// `commonjs` takes the top-level `return` CommonJS's wrapper allows. No
// node for parentheses: `(function () {})` is a function.
export function parse(text, lang) {
  const { parseSync } = getParser()
  let error
  for (const sourceType of ['unambiguous', 'commonjs']) {
    try {
      const parsed = parseSync(`source.${lang}`, text, { sourceType, lang, preserveParens: false })
      const errors = parsed.errors.filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')
      if (errors.length === 0) return { program: parsed.program }
      error ??= errors[0].message
    } catch (cause) {
      error ??= cause.message
    }
  }
  return { error }
}

// `a` and `b` passed along rather than closed over: no closure per node.
export function forEachChild(node, visit, a, b) {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item?.type === 'string') visit(item, a, b)
    } else if (typeof value?.type === 'string') {
      visit(value, a, b)
    }
  }
}

export function walk(node, enter) {
  enter(node)
  forEachChild(node, walk, enter)
}
