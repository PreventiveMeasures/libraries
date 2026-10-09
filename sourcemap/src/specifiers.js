import { walk } from './parser.js'

// The modules a program names, read as stasis reads them: { kind,
// specifier }, the specifier null for a computed one. Type-ness is the
// statement's, as type erasure decides it: `import type` and `export type`
// go, `import { type A }` still loads its module and stays. A `require`
// is one by its name alone: a UMD or AMD factory is handed the real one as
// a parameter.

// A string a call names its module by: a string literal, or a template
// literal with nothing interpolated.
export function literalSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked ?? null
  return null
}

// The module `node` names, or null where it names none.
export function specifierOf(node) {
  switch (node.type) {
    case 'ImportDeclaration':
      return node.importKind === 'type' ? null : { kind: 'import', specifier: node.source.value }
    case 'ExportNamedDeclaration':
      return node.source === null || node.exportKind === 'type' ? null : { kind: 'export-from', specifier: node.source.value }
    case 'ExportAllDeclaration':
      return node.exportKind === 'type' ? null : { kind: 'export-from', specifier: node.source.value }
    case 'ImportExpression':
      return { kind: 'dynamic-import', specifier: literalSpecifier(node.source) }
    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length > 0 ? { kind: 'require', specifier: literalSpecifier(node.arguments[0]) } : null
    // TypeScript's `import a = require(…)`; `import a = A.b` names no module.
    case 'TSImportEqualsDeclaration':
      return node.moduleReference.type === 'TSExternalModuleReference' ? { kind: 'require', specifier: literalSpecifier(node.moduleReference.expression) } : null
    default:
      return null
  }
}

export function specifiersOf(program) {
  const found = []
  walk(program, (node) => {
    const named = specifierOf(node)
    if (named) found.push(named)
  })
  return found
}
