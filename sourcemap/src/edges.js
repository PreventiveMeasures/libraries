import { edgeList, externalEdge, indexFiles, languageOf, resolveSpecifier } from './files.js'
import { fileAt, lineStarts } from './map.js'
import { metroEdges } from './metro.js'
import { forEachChild, parse, specifierOf, specifiersOf } from './parser.js'
import { scanSpecifiers } from './scan.js'
import { isWebpack, isWebpackOwn, webpackEdges } from './webpack.js'

// A file oxc does not parse, Flow mostly, is read by the scanner instead.
export function importEdges(map, { callees = [] } = {}) {
  const index = indexFiles(map.files)
  const named = new Set(callees)
  const { edges, add } = edgeList()
  const failed = []
  const unscanned = []
  for (const from of map.files) {
    const lang = from.path === null ? null : languageOf(from.path)
    if (lang === 'json') continue
    if (lang === null || from.content === null) {
      unscanned.push(from)
      continue
    }
    const { program, error } = parse(from.content, lang)
    if (!program) failed.push({ file: from, error })
    for (const { kind, specifier, callee } of program ? specifiersOf(program, named) : scanSpecifiers(from.content, named)) {
      const target = specifier === null ? { to: null } : resolveSpecifier(index, from, specifier)
      const key = `${kind}\0${callee ?? ''}\0${JSON.stringify(specifier)}`
      if (target.to !== from) add(from, key, { from, kind, specifier, ...(callee && { callee }), ...target })
    }
  }
  return { edges, failed, unscanned }
}

// Enough of JavaScript's scoping to follow a name in a bundle, where a
// minifier reuses short names in scope after scope. Two passes, the first
// declaring, so that a use ahead of its declaration resolves too.

function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    if (s.names.has(name)) return s.names.get(name)
  }
  return null
}

function patternNames(pattern, out = []) {
  const type = pattern?.type
  if (type === 'Identifier') out.push(pattern)
  else if (type === 'ObjectPattern') for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out)
  else if (type === 'ArrayPattern') for (const p of pattern.elements) patternNames(p, out)
  else if (type === 'AssignmentPattern' || type === 'RestElement') patternNames(pattern.left ?? pattern.argument, out)
  return out
}

// Types say nothing about what runs.
const TYPES = new Set(['TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'])

// Made in the declaring pass, found in the other.
function scopeFor(node, parent, isFunction, pass) {
  if (!pass.declaring) return pass.scopes.get(node)
  const scope = { parent, names: new Map() }
  scope.fn = isFunction || parent === null ? scope : parent.fn
  pass.scopes.set(node, scope)
  return scope
}

// `imported`: the module of an import binding.
function declare(scope, pass, identifiers, imported) {
  if (!pass.declaring) return
  for (const id of identifiers) {
    pass.declared.set(id, imported)
    if (!scope.names.has(id.name)) scope.names.set(id.name, id)
  }
}

const children = (node, scope, pass) => forEachChild(node, visit, scope, pass)

function visitFunction(node, scope, pass) {
  const inner = scopeFor(node, scope, true, pass)
  // An ordinary function's own `arguments`, no file's declaration.
  if (pass.declaring && node.type !== 'ArrowFunctionExpression') inner.names.set('arguments', null)
  if (node.id) declare(node.type === 'FunctionDeclaration' ? scope : inner, pass, [node.id])
  declare(inner, pass, node.params.flatMap((param) => patternNames(param.type === 'TSParameterProperty' ? param.parameter : param)))
  for (const param of node.params) visit(param, inner, pass)
  // The body's block is the function's own scope, not one inside it; but
  // with parameters more than names, which may hold initializers, the
  // body's declarations are a scope those do not see.
  if (node.body?.type !== 'BlockStatement') {
    if (node.body) visit(node.body, inner, pass)
    return
  }
  const body = node.params.every((param) => param.type === 'Identifier') ? inner : scopeFor(node.body, inner, true, pass)
  children(node.body, body, pass)
}

function visitClass(node, scope, pass) {
  const inner = scopeFor(node, scope, false, pass)
  if (node.id) declare(node.type === 'ClassDeclaration' ? scope : inner, pass, [node.id])
  if (node.superClass) visit(node.superClass, inner, pass)
  visit(node.body, inner, pass)
}

// A module the generated code names, or computes, which the bundler left to
// the runtime; but a require() of a `require` the bundle declares is the
// bundle's own.
function external(node, scope, pass) {
  if (pass.declaring) return
  const named = specifierOf(node)
  if (named === null) return
  if (named.kind === 'require' && lookup(scope, 'require') !== null) return
  pass.addExternal(node, named.kind, named.specifier)
}

// Their keys are names, but where computed.
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty'])

// A name in one file for a declaration in another; a global is no file's.
function reference(node, scope, pass) {
  if (pass.declaring || pass.declared.has(node)) return
  const binding = lookup(scope, node.name)
  if (binding === null) return
  const imported = pass.declared.get(binding)
  if (imported === undefined) pass.link(pass.at(node), pass.at(binding), 'reference')
  else pass.addExternal(node, 'import', imported)
}

function visit(node, scope, pass) {
  if (TYPES.has(node.type)) return
  switch (node.type) {
    case 'Identifier':
      return reference(node, scope, pass)
    // A component JSX names, `<Button>`, or `<ui.Card>`'s `ui`; a lowercase
    // `<div>` is the host's own element.
    case 'JSXOpeningElement': {
      let name = node.name
      while (name.type === 'JSXMemberExpression') name = name.object
      if (name.type === 'JSXIdentifier' && (name !== node.name || !/^[a-z]/u.test(name.name))) reference(name, scope, pass)
      for (const attribute of node.attributes) visit(attribute, scope, pass)
      return
    }
    case 'ImportDeclaration':
      declare(scope, pass, node.specifiers.map((specifier) => specifier.local), node.source.value)
      return external(node, scope, pass)
    case 'ExportAllDeclaration':
      return external(node, scope, pass)
    // Re-exported from another module, its specifiers name nothing here.
    case 'ExportNamedDeclaration':
      return node.source === null ? children(node, scope, pass) : external(node, scope, pass)
    case 'ExportSpecifier':
      return visit(node.local, scope, pass)
    case 'ImportExpression':
    case 'CallExpression':
      external(node, scope, pass)
      return children(node, scope, pass)
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return visitFunction(node, scope, pass)
    case 'ClassDeclaration':
    case 'ClassExpression':
      return visitClass(node, scope, pass)
    case 'VariableDeclaration':
      declare(node.kind === 'var' ? scope.fn : scope, pass, node.declarations.flatMap((declarator) => patternNames(declarator.id)))
      return children(node, scope, pass)
    case 'CatchClause': {
      const inner = scopeFor(node, scope, false, pass)
      if (node.param) declare(inner, pass, patternNames(node.param))
      return children(node, inner, pass)
    }
    case 'BlockStatement':
    case 'StaticBlock':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
      return children(node, scopeFor(node, scope, node.type === 'StaticBlock', pass), pass)
    // Its discriminant is read before its cases' block is a scope.
    case 'SwitchStatement': {
      visit(node.discriminant, scope, pass)
      const inner = scopeFor(node, scope, false, pass)
      for (const branch of node.cases) visit(branch, inner, pass)
      return
    }
    case 'MemberExpression':
      visit(node.object, scope, pass)
      if (node.computed) visit(node.property, scope, pass)
      return
    case 'LabeledStatement':
      return visit(node.body, scope, pass)
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MetaProperty':
      return
    default:
      if (!KEYED.has(node.type)) return children(node, scope, pass)
      if (node.computed) visit(node.key, scope, pass)
      if (node.value) visit(node.value, scope, pass)
  }
}

// A scope-hoisted bundle (esbuild, rollup) drops the imports and leaves one
// scope where every module's names meet: code from one file naming a
// declaration from another is that file using the other. Code in a file of
// `skip` is no file's.
function referenceEdges(program, map, starts, skip) {
  const at = (node) => {
    const file = fileAt(map, starts, node.start)
    return skip.has(file) ? null : file
  }
  const { edges, add, link } = edgeList()
  const addExternal = (node, kind, specifier) => {
    const from = at(node)
    if (from) add(from, `${kind}\0${JSON.stringify(specifier)}`, externalEdge(from, kind, specifier))
  }
  const shared = { scopes: new Map(), declared: new Map() }
  for (const pass of [{ ...shared, declaring: true }, { ...shared, at, link, addExternal }]) {
    children(program, scopeFor(program, null, true, pass), pass)
  }
  return edges
}

export function bundleEdges(map, code) {
  const metro = metroEdges(map, code)
  if (metro) return { edges: metro }
  if (code == null) return { edges: importEdges(map).edges }
  const { program, error } = parse(code, 'jsx')
  if (!program) throw new Error(`bundleEdges: the bundle does not parse: ${error}`)
  const starts = lineStarts(code)
  // webpack's runtime, and its stand-ins for externals, are no files.
  const references = referenceEdges(program, map, starts, new Set(map.files.filter(isWebpackOwn)))
  return { edges: isWebpack(map) ? [...webpackEdges(program, map, starts), ...references] : references }
}
