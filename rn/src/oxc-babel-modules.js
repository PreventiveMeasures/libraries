// Imports, exports and JSX of oxc-parser's AST (ESTree), as @babel/parser
// makes them, by type, as oxc-babel-nodes.js has the rest.

import { trailingComma } from './babel-comments.js'
import { Unconverted, children, clone, literal, string } from './oxc-babel-nodes.js'

// Babel 7 has `assertions` or `attributes` as its plugins have them.
function moduleSource(node) {
  if (node.phase !== null && node.phase !== undefined) throw new Unconverted('import phase')
  delete node.phase
  if (node.attributes !== undefined && node.attributes.length > 0) throw new Unconverted('import attributes')
}

function convertImportCall(node, c) {
  if (node.phase !== null && node.phase !== undefined) throw new Unconverted('import phase')
  if (trailingComma(c.code, c.commentStarts, node.end - 1) !== -1) throw new Unconverted('trailing comma')
  c.locate(node)
  if (c.importExpressions) {
    node.source = c.convert(node.source)
    node.options = c.maybe(node.options)
    delete node.phase
    return c.finish(node)
  }
  const call = c.create('CallExpression', node.start, node.end)
  call.callee = c.finish(c.create('Import', node.start, node.start + 'import'.length))
  call.arguments = [c.convert(node.source), ...(node.options === null || node.options === undefined ? [] : [c.convert(node.options)])]
  return c.finish(call)
}

function convertImport(node, c) {
  moduleSource(node)
  c.locate(node)
  // Babel's flow plugin names the kind of an import with a `from`.
  if (c.flow && (node.specifiers.length > 0 || c.code.slice(node.start, node.source.start).includes('{'))) node.importKind = 'value'
  node.specifiers = c.list(node.specifiers)
  node.source = string(node.source, c)
  return c.finish(node)
}

function convertImportSpecifier(node, c) {
  c.locate(node)
  // `import { a }`: the local, the imported name's clone.
  const single = node.local.start === node.imported.start
  node.imported = c.convert(node.imported)
  node.local = single ? clone(node.imported, c) : c.convert(node.local)
  if (c.flow) node.importKind = null
  return c.finish(node)
}

function convertExportSpecifier(node, c) {
  c.locate(node)
  // `export { a }`: the exported name, the local's clone.
  const single = node.exported.start === node.local.start
  node.local = c.convert(node.local)
  node.exported = single ? clone(node.local, c) : c.convert(node.exported)
  return c.finish(node)
}

function convertExport(node, c) {
  moduleSource(node)
  c.locate(node)
  if (c.flow) node.exportKind = 'value'
  node.declaration = c.maybe(node.declaration)
  node.specifiers = c.list(node.specifiers)
  node.source = node.source === null ? null : string(node.source, c)
  return c.finish(node)
}

function convertExportAll(node, c) {
  moduleSource(node)
  c.locate(node)
  if (c.flow) node.exportKind = 'value'
  if (node.exported === null) {
    delete node.exported
    node.source = string(node.source, c)
    return c.finish(node)
  }
  // `export * as ns from`, as Babel 7 has it.
  const specifier = c.create('ExportNamespaceSpecifier', c.code.indexOf('*', node.start), node.exported.end)
  specifier.exported = c.convert(node.exported)
  c.finish(specifier)
  const named = c.create('ExportNamedDeclaration', node.start, node.end)
  if (c.flow) named.exportKind = 'value'
  named.specifiers = [specifier]
  named.source = string(node.source, c)
  named.attributes = node.attributes
  return c.finish(named)
}

// Babel ends `import` of `import.meta` at the dot.
function checkMeta(node, c) {
  if (node.meta.name === 'import' && c.code.codePointAt(node.meta.end) !== 46) throw new Unconverted('import.meta')
}

// Babel decodes HTML entities in JSX, which oxc-parser leaves.
function jsxString(raw) {
  if (raw.includes('&')) throw new Unconverted('JSX entity')
  return raw
}

function convertJsxText(node, c) {
  const text = c.create('JSXText', node.start, node.end)
  text.extra = { rawValue: jsxString(node.raw), raw: node.raw }
  text.value = node.raw
  return c.finish(text)
}

function convertJsxAttribute(node, c) {
  c.locate(node)
  node.name = c.convert(node.name)
  node.value = node.value?.type === 'Literal' ? literal(node.value, c, 'StringLiteral', jsxString(node.value.raw).slice(1, -1)) : c.maybe(node.value)
  return c.finish(node)
}

export const MODULE_NODES = new Map([
  ['ImportExpression', convertImportCall],
  ['ImportDeclaration', convertImport],
  ['ImportSpecifier', convertImportSpecifier],
  ['ImportDefaultSpecifier', children(['local'])],
  ['ImportNamespaceSpecifier', children(['local'])],
  ['ExportSpecifier', convertExportSpecifier],
  ['ExportNamedDeclaration', convertExport],
  ['ExportAllDeclaration', convertExportAll],
  ['ExportDefaultDeclaration', children(['declaration'])],
  ['MetaProperty', children(['meta', 'property'], checkMeta)],
  ['JSXText', convertJsxText],
  ['JSXAttribute', convertJsxAttribute],
  ['JSXOpeningFragment', (node, c) => c.finish(c.create('JSXOpeningFragment', node.start, node.end))],
  ['JSXElement', children(['openingElement', 'children', 'closingElement'])],
  ['JSXOpeningElement', children(['name', 'attributes'])],
  ['JSXClosingElement', children(['name'])],
  ['JSXFragment', children(['openingFragment', 'children', 'closingFragment'])],
  ['JSXClosingFragment', children([])],
  ['JSXIdentifier', children([])],
  ['JSXNamespacedName', children(['namespace', 'name'])],
  ['JSXMemberExpression', children(['object', 'property'])],
  ['JSXSpreadAttribute', children(['argument'])],
  ['JSXExpressionContainer', children(['expression'])],
  ['JSXEmptyExpression', children([])],
  ['JSXSpreadChild', children(['expression'])],
])
