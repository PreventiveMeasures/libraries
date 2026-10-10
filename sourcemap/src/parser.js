// Node's loader; package.json's `browser` field points a browser bundle at
// oxc.browser.js instead.
import { getParser } from './oxc.node.js'

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

// The modules a node requests, read as stasis reads them. Type-ness is the
// statement's, as type erasure decides it: `import type` goes, while
// `import { type A }` still loads its module. A `require` is one by its
// name alone: a UMD or AMD factory is handed the real one as a parameter.

function literalSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked ?? null
  return null
}

// `callees`: functions taking a module's name, as require does:
// `internalBinding('crypto')`.
export function specifierOf(node, callees = new Set()) {
  switch (node.type) {
    case 'ImportDeclaration':
      return node.importKind === 'type' ? null : { kind: 'import', specifier: node.source.value }
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      return node.source === null || node.exportKind === 'type' ? null : { kind: 'export-from', specifier: node.source.value }
    case 'ImportExpression':
      return { kind: 'dynamic-import', specifier: literalSpecifier(node.source) }
    case 'CallExpression': {
      const { name } = node.callee.type === 'Identifier' ? node.callee : {}
      if ((name !== 'require' && !callees.has(name)) || node.arguments.length === 0) return null
      return { kind: 'require', specifier: literalSpecifier(node.arguments[0]), ...(name !== 'require' && { callee: name }) }
    }
    // TypeScript's `import a = require(…)`; `import a = A.b` names no module,
    // and `import type a = require(…)` is erased.
    case 'TSImportEqualsDeclaration':
      return node.moduleReference.type === 'TSExternalModuleReference' && node.importKind !== 'type' ? { kind: 'require', specifier: literalSpecifier(node.moduleReference.expression) } : null
    default:
      return null
  }
}

export function specifiersOf(program, callees) {
  const found = []
  const visit = (node) => {
    const named = specifierOf(node, callees)
    if (named) found.push(named)
    forEachChild(node, visit)
  }
  visit(program)
  return found
}
