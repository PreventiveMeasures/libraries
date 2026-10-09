import { forEachChild } from './parser.js'
import { specifierOf } from './specifiers.js'

// Enough of JavaScript's scoping to follow a name in a bundle, where a
// minifier reuses short names in scope after scope. Two passes, the first
// declaring, so that a use ahead of its declaration resolves too.

function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    const binding = s.names.get(name)
    if (binding) return binding
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
  if (node.id) declare(node.type === 'FunctionDeclaration' ? scope : inner, pass, [node.id])
  declare(inner, pass, node.params.flatMap((param) => patternNames(param.type === 'TSParameterProperty' ? param.parameter : param)))
  for (const param of node.params) visit(param, inner, pass)
  // The body's block is the function's own scope, not one inside it.
  if (node.body?.type === 'BlockStatement') children(node.body, inner, pass)
  else if (node.body) visit(node.body, inner, pass)
}

function visitClass(node, scope, pass) {
  const inner = scopeFor(node, scope, false, pass)
  if (node.id) declare(node.type === 'ClassDeclaration' ? scope : inner, pass, [node.id])
  if (node.superClass) visit(node.superClass, inner, pass)
  visit(node.body, inner, pass)
}

// A module the generated code names, which the bundler left to the runtime;
// but a require() of a `require` the bundle declares is the bundle's own.
function external(node, scope, pass) {
  if (pass.declaring) return
  const named = specifierOf(node)
  if (named === null || named.specifier === null) return
  if (named.kind === 'require' && lookup(scope, 'require') !== null) return
  pass.external(node, named.kind, named.specifier)
}

// Their keys are names, but where computed.
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty'])

function visit(node, scope, pass) {
  if (TYPES.has(node.type)) return
  switch (node.type) {
    case 'Identifier':
      if (!pass.declaring && !pass.declared.has(node)) {
        const binding = lookup(scope, node.name)
        pass.reference(node, binding, pass.declared.get(binding))
      }
      return
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
    case 'SwitchStatement':
      return children(node, scopeFor(node, scope, node.type === 'StaticBlock', pass), pass)
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

// `reference(identifier, binding, imported)`, binding null for a global;
// `external(node, kind, specifier)` for a module left to the runtime.
export function resolveReferences(program, callbacks) {
  const shared = { scopes: new Map(), declared: new Map() }
  for (const pass of [{ ...shared, declaring: true }, { ...shared, ...callbacks, declaring: false }]) {
    children(program, scopeFor(program, null, true, pass), pass)
  }
}
