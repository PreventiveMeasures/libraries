// A text's scopes and variables, each name read a variable's or a global's, or
// `{ reason }` where names can't all be followed. Renamable (`aside`): short and
// declared, and no script's global, export's or import's own name, or shorthand.

import { getOxc } from '#oxc'
import { MINIFIED, NAME_READS, RENAMED_MAX_LENGTH, declared, hoistedPast, holds, resolve, saysStrict } from './syntax.js'

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
// Statements whose `let`, `const`, `class` and functions are their own.
const BLOCKS = new Set(['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'])
// Globals that make a script a CommonJS module, its top level its own.
const COMMONJS = new Set(['exports', 'module', 'require'])

// oxc is loaded outside the try: one missing is no text that won't parse. A text
// oxc's semantic check finds an error in is one it can't vouch for.
function parsed(text, extension) {
  const sourceType = extension === 'mjs' ? 'module' : extension === 'cjs' ? 'commonjs' : 'unambiguous'
  const { parseSync } = getOxc()
  try {
    const result = parseSync('file.js', text, { lang: 'jsx', sourceType, showSemanticErrors: true })
    return result.errors.length > 0 ? null : result.program
  } catch {
    return null
  }
}

function scope(s, parent, fn) {
  const made = { parent, fn, names: new Map(), strict: parent?.strict ?? false }
  s.scopes.push(made)
  return made
}

// A body's `var` or function named as one of its parameters is that parameter:
// `function f(a) { var a; return a }` returns its argument.
function declare(s, where, node) {
  const at = where.parameters?.names.has(node.name) ? where.parameters : where
  let variable = at.names.get(node.name)
  if (!variable) {
    variable = { name: node.name, scope: at }
    at.names.set(node.name, variable)
    s.variables.push(variable)
  }
  s.declarations.set(node, [variable, at])
  return variable
}

const fnOf = (where) => (where.fn ? where : fnOf(where.parent))

// Two variables that must keep one name, read from then on as the first.
function join(s, kept, gone) {
  if (kept === gone || !s.variables.includes(gone)) return
  for (const path of gone.through ?? []) (kept.through ??= []).push(path)
  for (const at of s.scopes) for (const [name, variable] of at.names) if (variable === gone) at.names.set(name, kept)
  for (const [node, [variable, where]] of s.declarations) if (variable === gone) s.declarations.set(node, [kept, where])
  s.variables.splice(s.variables.indexOf(gone), 1)
}

// A `var` is its function's, passing the blocks it is in on the way (`through`);
// one named as a `catch` parameter it is in keeps one name with it.
function declareVariables(node, where, s) {
  for (const declarator of node.declarations) {
    for (const id of declared(declarator.id)) {
      const variable = declare(s, node.kind === 'var' ? fnOf(where) : where, id)
      if (node.kind !== 'var') continue
      const path = []
      for (let at = where; !at.fn; at = at.parent) path.push(at)
      if (path.length > 0) (variable.through ??= []).push(path)
      const caught = path.find((at) => at.caught && at.names.has(id.name))
      if (caught) join(s, caught.names.get(id.name), variable)
    }
  }
}

// An imported or exported name is no variable's; a variable imported or
// exported by its own name keeps it.
function moduleNames(node, s) {
  if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) {
      declare(s, s.root, specifier.local)
      if (specifier.type !== 'ImportSpecifier') continue
      s.others.add(specifier.imported)
      if (specifier.imported.start === specifier.local.start) s.keeping.add(specifier.local)
    }
    return
  }
  for (const specifier of node.specifiers) {
    s.others.add(specifier.exported)
    if (node.source) s.others.add(specifier.local)
    else if (specifier.exported.start === specifier.local.start) s.keeping.add(specifier.local)
  }
  if (node.declaration?.type === 'VariableDeclaration') for (const declarator of node.declaration.declarations) for (const id of declared(declarator.id)) s.keeping.add(id)
  else if (node.declaration?.id) s.keeping.add(node.declaration.id)
}

// Names that are no variable's (keys, labels), names kept, and the properties
// names are read through.
function otherNames(node, s) {
  switch (node.type) {
    case 'ExportDefaultDeclaration': if (node.declaration.id) s.keeping.add(node.declaration.id); break
    case 'ExportAllDeclaration': if (node.exported) s.others.add(node.exported); break
    case 'ImportAttribute': s.others.add(node.key); break
    case 'MemberExpression':
      if (!node.computed) s.others.add(node.property)
      if (!node.computed && NAME_READS.has(node.property.name)) s.reads.add(node.property.name)
      break
    case 'ObjectPattern':
      for (const { type, computed, key } of node.properties) if (type === 'Property' && !computed && NAME_READS.has(key.name)) s.reads.add(key.name)
      break
    case 'Literal': if (NAME_READS.has(node.value)) s.reads.add(node.value); break
    case 'TemplateLiteral': for (const { value } of node.quasis) if (NAME_READS.has(value.cooked)) s.reads.add(value.cooked); break
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': case 'AccessorProperty':
      if (node.computed) break
      if (node.shorthand) s.keeping.add(node.key)
      else s.others.add(node.key)
      break
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': if (node.label) s.others.add(node.label); break
    case 'MetaProperty': s.others.add(node.meta).add(node.property); break
    default: break
  }
}

// What a node declares, or why its names can't all be followed.
function visit(node, where, s) {
  switch (node.type) {
    case 'JSXElement': case 'JSXFragment': return 'jsx'
    case 'WithStatement': return 'dynamic'
    case 'VariableDeclaration': declareVariables(node, where, s); return null
    case 'FunctionDeclaration':
      if (node.id && !where.fn && !where.strict) return 'block-function'
      if (node.id) declare(s, where, node.id)
      return null
    // A function an `if` holds without braces is one in a block.
    case 'IfStatement':
      return !where.strict && [node.consequent, node.alternate].some((clause) => clause?.type === 'FunctionDeclaration') ? 'block-function' : null
    case 'ClassDeclaration': if (node.id) declare(s, where, node.id); return null
    case 'ImportDeclaration': case 'ExportNamedDeclaration': moduleNames(node, s); return null
    default: otherNames(node, s); return null
  }
}

// Parameters are a scope, the body's declarations one apart (a default reads
// none: `(a = b) => { var b }`), and an expression's own name one around both.
function enterFunction(node, where, s) {
  const named = node.type !== 'FunctionDeclaration' && node.id ? scope(s, where, false) : where
  if (named !== where) declare(s, named, node.id)
  if (node.type === 'ClassExpression') {
    for (const child of [node.superClass, node.body, ...node.decorators ?? []]) if (child) s.work.push([child, named])
    return
  }
  const parameters = scope(s, named, true)
  if (node.body?.type === 'BlockStatement' && saysStrict(node.body.body)) parameters.strict = true
  for (const parameter of node.params) {
    for (const id of declared(parameter)) declare(s, parameters, id)
    s.work.push([parameter, parameters])
  }
  if (node.body?.type === 'BlockStatement') {
    const body = Object.assign(scope(s, parameters, true), { parameters })
    for (const statement of node.body.body) s.work.push([statement, body])
  } else if (node.body) s.work.push([node.body, parameters])
}

// A node's children, each with the scope it is read in.
function enter(node, where, s) {
  if (FUNCTIONS.has(node.type) || node.type === 'ClassExpression') {
    enterFunction(node, where, s)
    return
  }
  let inner = where
  if (BLOCKS.has(node.type)) inner = scope(s, where, false)
  else if (node.type === 'ClassBody') inner = Object.assign(scope(s, where, false), { strict: true })
  else if (node.type === 'StaticBlock') inner = scope(s, where, true)
  else if (node.type === 'CatchClause') {
    inner = Object.assign(scope(s, where, false), { caught: true, simple: node.param?.type === 'Identifier' })
    for (const id of declared(node.param)) declare(s, inner, id)
  }
  // A switch's discriminant is read before its cases' scope is entered.
  for (const [field, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') s.work.push([child, inner])
    } else if (value && typeof value.type === 'string' && field !== 'type') s.work.push([value, field === 'discriminant' ? where : inner])
  }
}

// A work list rather than a recursion: a minified file's expressions nest deeply.
function walk(program) {
  const s = { declarations: new Map(), scopes: [], variables: [], keeping: new Set(), others: new Set(), reads: new Set(), references: [], work: [] }
  s.root = Object.assign(scope(s, null, true), { strict: program.sourceType === 'module' || saysStrict(program.body) })
  s.work.push([program, s.root])
  while (s.work.length > 0) {
    const [node, where] = s.work.pop()
    if (node.type === 'Identifier') {
      if (!s.declarations.has(node) && !s.others.has(node)) s.references.push([node, where])
      continue
    }
    const reason = visit(node, where, s)
    if (reason) return { reason }
    enter(node, where, s)
  }
  return s
}

// Each name read resolved outward from where it is read, else a global's.
// `eval(...)` reads names by their spelling, wherever `eval` is declared.
function resolved(program, s) {
  let commonjs = false
  const globals = [], occurrences = [...s.declarations].map(([node, [variable, where]]) => [node, variable, where])
  for (const [node, where] of s.references) {
    if (node.name === 'eval') return { reason: 'dynamic' }
    const variable = resolve(node.name, where)
    if (variable) occurrences.push([node, variable, where])
    else {
      globals.push([node, where])
      if (COMMONJS.has(node.name)) commonjs = true
    }
  }
  for (const [node, variable] of occurrences) if (s.keeping.has(node)) variable.kept = true
  const own = program.sourceType === 'module' || program.sourceType === 'commonjs' || commonjs
  for (const variable of s.variables) variable.aside = variable.name.length <= RENAMED_MAX_LENGTH && MINIFIED.test(variable.name) && !variable.kept && (own || variable.scope !== s.root)
  // A shorthand property's two names are one, at one place.
  const byStart = (x, y) => x[0].start - y[0].start
  occurrences.sort(byStart)
  globals.sort(byStart)
  for (let i = 1; i < occurrences.length; i++) {
    const [[node, variable], [previous, other]] = [occurrences[i], occurrences[i - 1]]
    holds(node.start !== previous.start || variable === other, `${node.name} at ${node.start} two variables'`)
  }
  const deduplicated = occurrences.filter((entry, i) => i === 0 || entry[0].start !== occurrences[i - 1][0].start)
  const names = new Set([...s.variables.map(({ name }) => name), ...globals.map(([node]) => node.name)])
  return { scopes: s.scopes, variables: s.variables, occurrences: deduplicated, globals, names, reads: s.reads, module: program.sourceType === 'module', commonjs: program.sourceType === 'commonjs', own }
}

export function analyze(text, extension) {
  const program = parsed(text, extension)
  if (!program) return { reason: 'unparsed' }
  const s = walk(program)
  if (s.reason) return s
  // A `var` named as a block's it hoists past does not compile, which oxc's
  // semantic check misses beside a `catch`.
  for (const variable of s.variables) for (const path of variable.through ?? []) if (hoistedPast(variable, path, variable.name, (at) => at.names).length > 0) return { reason: 'unparsed' }
  return resolved(program, s)
}
