// The lists a JS config (a babel.config.js, a metro.config.js) names, read
// off its ESTree AST (parentheses kept or not, as oxc-parser keeps them),
// never run.

// The array methods making a list of the one they're called on.
const LIST_METHODS = new Set(['concat', 'filter', 'flat', 'slice'])
// How deep lists nest, as read: arrays of arrays `.flat()` flattens.
const MAX_DEPTH = 8

// Calls `fn` on each node of the AST `node`, depth first.
export function walkAst(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn)
    return
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  fn(node)
  for (const key of Object.keys(node)) if (key !== 'type') walkAst(node[key], fn)
}

// The string a literal or a template with no substitutions holds, else null.
export function literalString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked
  return null
}

// The method `node` calls on an object (`x.concat(...)` is 'concat'), on the
// one named `object` where given, else undefined.
export function memberCall(node, object) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return undefined
  if (object !== undefined && (node.callee.object.type !== 'Identifier' || node.callee.object.name !== object)) return undefined
  return node.callee.property.name
}

// The levels `.flat(arg)` flattens: 1 by default, else as written.
function flatDepth(arg) {
  if (arg === undefined) return 1
  if (arg.type === 'Identifier' && arg.name === 'Infinity') return MAX_DEPTH
  return arg.type === 'Literal' && typeof arg.value === 'number' ? arg.value : 1
}

const listName = (node) => (node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' && !node.computed ? node.property.name : undefined)

// What the lists of `lists` (the name of the key, variable or property
// holding one -> what its entries are taken as) in `program` hold: each such
// list, an array under the key at any depth, a variable or property so named
// or assigned, or one pushed onto either; through spreads, variables,
// branches and the array methods making a list of another. Each entry (the
// first of a `[name, options]` pair) is passed to `entry(type, node)`.
export function readLists(program, lists, entry) {
  const declarators = []
  walkAst(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarators.push(node)
  })
  const inits = Map.groupBy(declarators, (node) => node.id.name)
  const seen = new Map()
  // `depth` levels of arrays in `node` are lists (1 a list, 2 one `.flat()`
  // flattens); an array below them is an entry's `[name, options]` pair.
  const read = (node, type, depth) => {
    if (!node || depth > MAX_DEPTH) return
    const key = `${type}${depth}`
    if (!seen.has(node)) seen.set(node, new Set())
    if (seen.get(node).has(key)) return
    seen.get(node).add(key)
    if (node.type === 'ParenthesizedExpression') {
      read(node.expression, type, depth)
    } else if (node.type === 'ArrayExpression') {
      if (depth === 0) return read(node.elements[0], type, 0)
      for (const element of node.elements) {
        if (element?.type === 'SpreadElement') read(element.argument, type, depth)
        else read(element, type, depth - 1)
      }
    } else if (node.type === 'Identifier') {
      for (const { init } of inits.get(node.name) ?? []) read(init, type, depth)
    } else if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      for (const side of node.type === 'LogicalExpression' ? [node.left, node.right] : [node.consequent, node.alternate]) read(side, type, depth)
    } else if (depth > 0 && LIST_METHODS.has(memberCall(node))) {
      const method = memberCall(node)
      read(node.callee.object, type, Math.min(depth + (method === 'flat' ? flatDepth(node.arguments[0]) : 0), MAX_DEPTH))
      if (method === 'concat') for (const arg of node.arguments) read(arg.argument ?? arg, type, arg.type === 'SpreadElement' ? depth + 1 : depth)
    } else {
      entry(type, node)
    }
  }
  walkAst(program, (node) => {
    const [name, value] = node.type === 'Property' && !node.computed ? [node.key.name ?? node.key.value, node.value]
      : node.type === 'VariableDeclarator' ? [listName(node.id), node.init]
      : node.type === 'AssignmentExpression' ? [listName(node.left), node.right]
      : []
    if (lists.has(name)) read(value, lists.get(name), 1)
    // Or added to one: `push` and `unshift` each argument an entry, `concat`
    // as it concatenates.
    const method = memberCall(node)
    const type = method && lists.get(listName(node.callee.object))
    if (!type) return
    if (method === 'concat') read(node, type, 1)
    else if (method === 'push' || method === 'unshift') for (const arg of node.arguments) read(arg.argument ?? arg, type, arg.type === 'SpreadElement' ? 1 : 0)
  })
}
