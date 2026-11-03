// An ES module's record of its imports by name and its exports, as Babel's AST has them, types (TS's,
// Flow's) left out: babel-transformer.js's IMPORTS takes it as the plugins leave the program, else as it
// is entered; esm-imports.js checks the imports against the exports.

const TYPE_KINDS = new Set(['type', 'typeof'])
const nameOf = (node) => (node.type === 'StringLiteral' ? node.value : node.name)
// The names a pattern binds.
const boundBy = (node) => {
  if (node == null) return []
  if (node.type === 'Identifier') return [node.name]
  if (node.type === 'ObjectPattern') return node.properties.flatMap((property) => boundBy(property.type === 'RestElement' ? property.argument : property.value))
  if (node.type === 'ArrayPattern') return node.elements.flatMap(boundBy)
  if (node.type === 'AssignmentPattern') return boundBy(node.left)
  return node.type === 'RestElement' ? boundBy(node.argument) : []
}
// The values a declaration exports: not a type's (TS's or Flow's), which has no value.
const VALUE_DECLARATIONS = new Set(['FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'EnumDeclaration'])
function declaredBy(declaration) {
  if (declaration.type === 'VariableDeclaration') return declaration.declarations.flatMap(({ id }) => boundBy(id))
  if (declaration.type === 'TSModuleDeclaration') return declaration.declare || declaration.id.type !== 'Identifier' ? [] : [declaration.id.name]
  return VALUE_DECLARATIONS.has(declaration.type) && !declaration.declare && declaration.id != null ? [declaration.id.name] : []
}

// An ES module's { imports: [{ specifier, names }], exports, stars }: the names it imports of each module
// (`default` of a default import; none of a namespace import), those it exports, and the modules it
// exports all of; null of a script (sourceType unambiguous), or of a file of no import or export of a value.
export function esModuleOf(program) {
  if (program.sourceType === 'script') return null
  const imports = []
  const exports = []
  const stars = []
  let esm = false
  const importing = (specifier, names) => names.length > 0 && imports.push({ specifier, names })
  for (const node of program.body) {
    const typed = TYPE_KINDS.has(node.importKind ?? node.exportKind)
    if (!typed && /^(?:Import|Export(?:All|Default|Named))Declaration$/u.test(node.type)) esm = true
    if (typed) continue
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
