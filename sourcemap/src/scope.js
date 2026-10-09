import { forEachChild } from './parser.js'
import { specifierOf } from './specifiers.js'

// Every identifier reference in a program, resolved to the identifier that
// declares it: enough of JavaScript's scoping to follow a name in a bundle,
// where a minifier reuses the same short names in scope after scope. Two
// passes, so a reference ahead of its declaration (hoisting, a function
// called before it is written) resolves like any other: the first declares,
// the second resolves.

function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    const binding = s.names.get(name)
    if (binding) return binding
  }
  return null
}

// The identifiers a binding pattern declares.
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

// The scope `node` opens: made in the declaring pass, found in the other.
function scopeFor(node, parent, isFunction, pass) {
  if (!pass.declaring) return pass.scopes.get(node)
  const scope = { parent, names: new Map() }
  scope.fn = isFunction || parent === null ? scope : parent.fn
  pass.scopes.set(node, scope)
  return scope
}

// Called in the declaring pass alone, the resolving pass not so much as
// working out the names: each identifier, with the module it imports where
// it is an import binding.
function declare(scope, pass, identifiers, imported) {
  for (const id of identifiers) {
    pass.declared.set(id, imported)
    if (!scope.names.has(id.name)) scope.names.set(id.name, id)
  }
}

const children = (node, scope, pass) => forEachChild(node, visit, scope, pass)

function visitFunction(node, scope, pass) {
  const inner = scopeFor(node, scope, true, pass)
  if (pass.declaring) {
    if (node.type === 'FunctionExpression' && node.id) declare(inner, pass, [node.id])
    declare(inner, pass, node.params.flatMap((param) => patternNames(param.type === 'TSParameterProperty' ? param.parameter : param)))
  }
  for (const param of node.params) visit(param, inner, pass)
  // The body's block is the function's own scope, not one inside it.
  if (node.body?.type === 'BlockStatement') children(node.body, inner, pass)
  else if (node.body) visit(node.body, inner, pass)
}

function visitClass(node, scope, pass) {
  const inner = scopeFor(node, scope, false, pass)
  if (pass.declaring && node.type === 'ClassExpression' && node.id) declare(inner, pass, [node.id])
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

// The keys of these that are names, not references: visited only where a
// computed key makes them an expression.
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
      if (pass.declaring) declare(scope, pass, node.specifiers.map((specifier) => specifier.local), node.source.value)
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
    case 'ClassDeclaration':
      if (pass.declaring && node.id) declare(scope, pass, [node.id])
      return node.type === 'FunctionDeclaration' ? visitFunction(node, scope, pass) : visitClass(node, scope, pass)
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return visitFunction(node, scope, pass)
    case 'ClassExpression':
      return visitClass(node, scope, pass)
    case 'VariableDeclaration':
      if (pass.declaring) declare(node.kind === 'var' ? scope.fn : scope, pass, node.declarations.flatMap((declarator) => patternNames(declarator.id)))
      return children(node, scope, pass)
    case 'CatchClause': {
      const inner = scopeFor(node, scope, false, pass)
      if (pass.declaring && node.param) declare(inner, pass, patternNames(node.param))
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

// Calls `reference(identifier, binding, specifier)` for every reference:
// the binding the declaring identifier or null for a global, the specifier
// the module it imports where it is an import. And `external(node, kind,
// specifier)` for every module the program leaves to the runtime.
export function resolveReferences(program, callbacks) {
  const shared = { scopes: new Map(), declared: new Map() }
  for (const pass of [{ ...shared, declaring: true }, { ...shared, ...callbacks, declaring: false }]) {
    children(program, scopeFor(program, null, true, pass), pass)
  }
}
