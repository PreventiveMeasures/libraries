import { literalSpecifier } from './specifiers.js'

// Every identifier reference in a program, resolved to the identifier that
// declares it: enough of JavaScript's scoping to follow a name in a bundle,
// where a minifier reuses the same short names in scope after scope. Two
// passes, so a reference ahead of its declaration (hoisting, a function
// called before it is written) resolves like any other: the first declares,
// the second resolves.

function newScope(parent, isFunction) {
  const scope = { parent, names: new Map(), fn: null }
  scope.fn = isFunction || parent === null ? scope : parent.fn
  return scope
}

function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    const binding = s.names.get(name)
    if (binding) return binding
  }
  return null
}

// The identifiers a binding pattern declares.
function patternNames(pattern, out = []) {
  switch (pattern?.type) {
    case 'Identifier':
      out.push(pattern)
      break
    case 'ObjectPattern':
      for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property.argument : property.value, out)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, out)
      break
    case 'AssignmentPattern':
      patternNames(pattern.left, out)
      break
    case 'RestElement':
      patternNames(pattern.argument, out)
      break
    default:
      break
  }
  return out
}

// Types say nothing about what runs.
const TYPES = new Set(['TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'])

function scopeFor(node, parent, isFunction, pass) {
  if (!pass.declaring) return pass.scopes.get(node)
  const scope = newScope(parent, isFunction)
  pass.scopes.set(node, scope)
  return scope
}

function declare(identifiers, scope, pass) {
  if (!pass.declaring) return
  for (const id of identifiers) {
    pass.declared.add(id)
    if (!scope.names.has(id.name)) scope.names.set(id.name, id)
  }
}

function children(node, scope, pass) {
  for (const field of Object.keys(node)) {
    if (field === 'type' || field === 'start' || field === 'end' || field === 'range' || field === 'loc') continue
    const value = node[field]
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item?.type === 'string') visit(item, scope, pass)
    } else if (value !== null && typeof value?.type === 'string') {
      visit(value, scope, pass)
    }
  }
}

function visitFunction(node, scope, pass) {
  const inner = scopeFor(node, scope, true, pass)
  if (node.type === 'FunctionExpression' && node.id) declare([node.id], inner, pass)
  declare(node.params.flatMap((param) => patternNames(param.type === 'TSParameterProperty' ? param.parameter : param)), inner, pass)
  for (const param of node.params) visit(param, inner, pass)
  // The body's block is the function's own scope, not one inside it.
  if (node.body?.type === 'BlockStatement') children(node.body, inner, pass)
  else if (node.body) visit(node.body, inner, pass)
}

function visitClass(node, scope, pass) {
  const inner = scopeFor(node, scope, false, pass)
  if (node.type === 'ClassExpression' && node.id) declare([node.id], inner, pass)
  if (node.superClass) visit(node.superClass, inner, pass)
  visit(node.body, inner, pass)
}

// A module named in the generated code: what it keeps of the imports the
// bundler left to the runtime.
function external(node, kind, specifier, pass) {
  if (!pass.declaring && specifier !== null) pass.external(node, kind, specifier)
}

// The keys of these that are names, not references: visited only where a
// computed key makes them an expression.
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty'])

function visitModule(node, scope, pass) {
  switch (node.type) {
    case 'ImportDeclaration':
      declare(node.specifiers.map((specifier) => specifier.local), scope, pass)
      if (pass.declaring) for (const specifier of node.specifiers) pass.imports.set(specifier.local, node.source.value)
      if (node.importKind !== 'type') external(node, 'import', node.source.value, pass)
      return true
    case 'ExportAllDeclaration':
      external(node, 'export-from', node.source.value, pass)
      return true
    case 'ExportNamedDeclaration':
      if (node.source === null) return false
      external(node, 'export-from', node.source.value, pass)
      return true
    case 'ExportSpecifier':
      visit(node.local, scope, pass)
      return true
    default:
      return false
  }
}

function visit(node, scope, pass) {
  if (TYPES.has(node.type) || visitModule(node, scope, pass)) return
  switch (node.type) {
    case 'Identifier':
      if (!pass.declaring && !pass.declared.has(node)) {
        const binding = lookup(scope, node.name)
        pass.reference(node, binding, binding === null ? undefined : pass.imports.get(binding))
      }
      return
    case 'FunctionDeclaration':
      if (node.id) declare([node.id], scope, pass)
      return visitFunction(node, scope, pass)
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return visitFunction(node, scope, pass)
    case 'ClassDeclaration':
      if (node.id) declare([node.id], scope, pass)
      return visitClass(node, scope, pass)
    case 'ClassExpression':
      return visitClass(node, scope, pass)
    case 'VariableDeclaration':
      declare(node.declarations.flatMap((declarator) => patternNames(declarator.id)), node.kind === 'var' ? scope.fn : scope, pass)
      return children(node, scope, pass)
    case 'CatchClause': {
      const inner = scopeFor(node, scope, false, pass)
      if (node.param) declare(patternNames(node.param), inner, pass)
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
    case 'ImportExpression':
      external(node, 'dynamic-import', literalSpecifier(node.source), pass)
      return children(node, scope, pass)
    case 'CallExpression':
      // A require() of nothing the bundle declares is one left to the runtime.
      if (node.callee.type === 'Identifier' && node.callee.name === 'require' && lookup(scope, 'require') === null) {
        external(node, 'require', literalSpecifier(node.arguments[0]), pass)
      }
      return children(node, scope, pass)
    default:
      if (KEYED.has(node.type)) {
        if (node.computed) visit(node.key, scope, pass)
        if (node.value) visit(node.value, scope, pass)
        return
      }
      return children(node, scope, pass)
  }
}

// Calls `reference(identifier, binding, specifier)` for every reference:
// the binding the declaring identifier or null for a global, the specifier
// the module it imports where it is an import. And `external(node, kind,
// specifier)` for every module the program leaves to the runtime.
export function resolveReferences(program, { reference, external: onExternal }) {
  const shared = { scopes: new Map(), declared: new Set(), imports: new Map() }
  const root = newScope(null, true)
  shared.scopes.set(program, root)
  children(program, root, { ...shared, declaring: true })
  children(program, root, { ...shared, declaring: false, reference, external: onExternal })
}
