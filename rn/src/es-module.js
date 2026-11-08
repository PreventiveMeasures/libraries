// An ES module's named imports and exports, read from Babel's AST without types, for esm-imports.js to
// check each import against what its module exports.

const TYPE_KINDS = new Set(['type', 'typeof'])
const nameOf = (node) => (node.type === 'StringLiteral' ? node.value : node.name)
const boundBy = (node) => {
  if (node == null) return []
  if (node.type === 'Identifier') return [node.name]
  if (node.type === 'ObjectPattern') return node.properties.flatMap((property) => boundBy(property.type === 'RestElement' ? property.argument : property.value))
  if (node.type === 'ArrayPattern') return node.elements.flatMap(boundBy)
  if (node.type === 'AssignmentPattern') return boundBy(node.left)
  return node.type === 'RestElement' ? boundBy(node.argument) : []
}
// Declarations of values; TS and Flow type declarations export none.
const VALUE_DECLARATIONS = new Set(['FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'EnumDeclaration', 'TSModuleDeclaration'])
function declaredBy(declaration) {
  if (declaration.type === 'VariableDeclaration') return declaration.declarations.flatMap(({ id }) => boundBy(id))
  return VALUE_DECLARATIONS.has(declaration.type) && !declaration.declare && declaration.id?.type === 'Identifier' ? [declaration.id.name] : []
}

// -> { imports: [{ specifier, names }], exports, stars } (`stars`: the modules of `export *`), or null for a
// script or a file with no value import or export. A namespace import names nothing.
export function esModuleOf(program) {
  if (program.sourceType === 'script') return null
  const imports = []
  const exports = []
  const stars = []
  let esm = false
  const importing = (specifier, names) => names.length > 0 && imports.push({ specifier, names })
  for (const node of program.body) {
    if (TYPE_KINDS.has(node.importKind ?? node.exportKind)) continue
    esm ||= /^(?:Import|Export(?:All|Default|Named))Declaration$/u.test(node.type)
    if (node.type === 'ImportDeclaration') {
      importing(node.source.value, node.specifiers.flatMap((each) => (each.type === 'ImportDefaultSpecifier' ? ['default'] : each.type === 'ImportSpecifier' && !TYPE_KINDS.has(each.importKind) ? [nameOf(each.imported)] : [])))
    } else if (node.type === 'ExportAllDeclaration') {
      stars.push(node.source.value)
    } else if (node.type === 'ExportDefaultDeclaration') {
      exports.push('default')
    } else if (node.type === 'ExportNamedDeclaration') {
      const specifiers = node.specifiers.filter((each) => !TYPE_KINDS.has(each.exportKind))
      if (node.declaration != null) exports.push(...declaredBy(node.declaration))
      exports.push(...specifiers.map((each) => nameOf(each.exported)))
      if (node.source != null) importing(node.source.value, specifiers.flatMap((each) => (each.type === 'ExportSpecifier' ? [nameOf(each.local)] : each.type === 'ExportDefaultSpecifier' ? ['default'] : [])))
    }
  }
  return esm ? { imports, exports, stars } : null
}
