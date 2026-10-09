import { walk } from './parser.js'

// The specifiers a module names, read as stasis reads them: { kind,
// specifier, start }, the specifier null for a computed one. Type-ness is
// the statement's, as type erasure decides it: `import type` and `export
// type` go, `import { type A }` still loads its module and stays.

// A string a call names its module by: a string literal, or a template
// literal with nothing interpolated.
export function literalSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked ?? null
  return null
}

function statementSpecifier(node) {
  switch (node.type) {
    case 'ImportDeclaration':
      return node.importKind === 'type' ? null : 'import'
    case 'ExportNamedDeclaration':
      return node.source !== null && node.exportKind !== 'type' ? 'export-from' : null
    case 'ExportAllDeclaration':
      return node.exportKind === 'type' ? null : 'export-from'
    default:
      return null
  }
}

// require() and import() anywhere, and TypeScript's `import a = require()`.
function callSpecifier(node) {
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length >= 1) {
    return ['require', node.arguments[0]]
  }
  if (node.type === 'ImportExpression') return ['dynamic-import', node.source]
  if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference?.type === 'TSExternalModuleReference') return ['require', node.moduleReference.expression]
  return null
}

export function specifiersOf(program) {
  const found = []
  for (const node of program.body) {
    const kind = statementSpecifier(node)
    if (kind) found.push({ kind, specifier: node.source.value, start: node.start })
  }
  walk(program, (node) => {
    const call = callSpecifier(node)
    if (call) found.push({ kind: call[0], specifier: literalSpecifier(call[1]), start: node.start })
  })
  return found
}
