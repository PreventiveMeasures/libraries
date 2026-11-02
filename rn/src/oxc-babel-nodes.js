// Each node of oxc-parser's AST (ESTree) as @babel/parser makes it, by its
// type (oxc-babel.js): each (node, c) -> its Babel node, `c` the file's
// context. Each finishes its Babel nodes in the order Babel does, for the
// comments each takes (babel-comments.js). Modules and JSX, in
// oxc-babel-modules.js.

import { trailingComma } from './babel-comments.js'

// Thrown where the AST has what isn't converted: Babel is left to parse it.
export class Unconverted extends Error {}

export function identifier(node, c) {
  c.locate(node)
  node.loc.identifierName = node.name
  return c.finish(node)
}

// A name Babel writes once and clones, which it doesn't finish.
export function clone(node, c) {
  const copy = node.type === 'Identifier' ? { type: 'Identifier', start: node.start, end: node.end, name: node.name } : { type: node.type, start: node.start, end: node.end, extra: { ...node.extra }, value: node.value }
  c.locate(copy)
  if (copy.type === 'Identifier') copy.loc.identifierName = copy.name
  return copy
}

export function literal(node, c, type, value) {
  const babel = c.create(type, node.start, node.end)
  babel.extra = { rawValue: value, raw: node.raw }
  babel.value = value
  return c.finish(babel)
}

export const string = (node, c) => literal(node, c, 'StringLiteral', node.value)

// A body's leading string statements, as Babel's directives, taken out of it.
export function directives(body, c) {
  let count = 0
  while (count < body.length && body[count].type === 'ExpressionStatement' && typeof body[count].directive === 'string') count++
  return body.splice(0, count).map(({ expression, start, end }) => {
    const raw = c.code.slice(expression.start, expression.end)
    const value = c.create('DirectiveLiteral', expression.start, expression.end)
    value.extra = { rawValue: raw.slice(1, -1), raw, expressionValue: expression.value }
    value.value = raw.slice(1, -1)
    c.finish(value)
    const directive = c.create('Directive', start, end)
    directive.value = value
    return c.finish(directive)
  })
}

function block(node, c, found = []) {
  c.locate(node)
  node.body = c.list(node.body)
  node.directives = found
  return c.finish(node)
}

// A function's fields, of an ESTree function, onto `node`.
function fn(node, c, from) {
  c.functions++
  node.id = c.maybe(from.id)
  node.generator = from.generator
  node.async = from.async
  node.params = c.list(from.params)
  node.body = from.body.type === 'BlockStatement' ? block(from.body, c, directives(from.body.body, c)) : c.convert(from.body)
  c.functions--
  return c.finish(node)
}

function noDecorators(node) {
  if (node.decorators !== undefined && node.decorators.length > 0) throw new Unconverted('decorators')
  delete node.decorators
}

// An optional chain's links, from its first `?.` on, as Babel's Optional*.
function chain(node) {
  if (node.type !== 'MemberExpression' && node.type !== 'CallExpression') return false
  if (!chain(node.type === 'MemberExpression' ? node.object : node.callee) && node.optional !== true) return false
  node.type = node.type === 'MemberExpression' ? 'OptionalMemberExpression' : 'OptionalCallExpression'
  node.optional = node.optional === true
  return true
}

const LITERALS = { number: 'NumericLiteral', string: 'StringLiteral' }

function convertLiteral(node, c) {
  if (node.regex !== undefined) {
    const regex = c.create('RegExpLiteral', node.start, node.end)
    regex.extra = { raw: node.raw }
    // As written: oxc-parser sorts the flags.
    const slash = node.raw.lastIndexOf('/')
    regex.pattern = node.raw.slice(1, slash)
    regex.flags = node.raw.slice(slash + 1)
    return c.finish(regex)
  }
  if (node.bigint !== undefined) return literal(node, c, 'BigIntLiteral', node.raw.slice(0, -1).replaceAll('_', ''))
  if (typeof node.value in LITERALS) return literal(node, c, LITERALS[typeof node.value], node.value)
  if (node.value === null) return c.finish(c.create('NullLiteral', node.start, node.end))
  const boolean = c.create('BooleanLiteral', node.start, node.end)
  boolean.value = node.value
  return c.finish(boolean)
}

function convertPrivateName(node, c) {
  const id = c.create('Identifier', node.start + 1, node.end)
  id.loc.identifierName = node.name
  id.name = node.name
  c.finish(id)
  const name = c.create('PrivateName', node.start, node.end)
  name.id = id
  return c.finish(name)
}

function convertProperty(node, c) {
  const { start, end, computed, shorthand, value } = node
  const key = c.convert(node.key)
  if (node.kind !== 'init' || node.method) {
    const method = c.create('ObjectMethod', start, end)
    method.method = node.method
    method.key = key
    method.computed = computed
    method.kind = node.method ? 'method' : node.kind
    return fn(method, c, value)
  }
  const property = c.create('ObjectProperty', start, end)
  property.method = false
  property.key = key
  property.computed = computed
  property.shorthand = shorthand
  if (!shorthand) property.value = c.convert(value)
  else if (value.type === 'AssignmentPattern') {
    // The key's clone, in a default, as `{ a = 1 }` has it.
    c.locate(value)
    value.left = clone(key, c)
    value.right = c.convert(value.right)
    property.value = c.finish(value)
  } else property.value = clone(key, c)
  if (shorthand) property.extra = { shorthand: true }
  return c.finish(property)
}

function convertMethod(node, c) {
  noDecorators(node)
  const isPrivate = node.key.type === 'PrivateIdentifier'
  const method = c.create(isPrivate ? 'ClassPrivateMethod' : 'ClassMethod', node.start, node.end)
  method.static = node.static
  method.key = c.convert(node.key)
  // A private name after `get`, `set` or `async`, which Babel reads as a key first.
  if (!isPrivate) method.computed = node.computed
  else if (node.kind === 'get' || node.kind === 'set' || node.value.async) method.computed = false
  method.kind = node.kind
  return fn(method, c, node.value)
}

function convertClassProperty(node, c) {
  noDecorators(node)
  const isPrivate = node.key.type === 'PrivateIdentifier'
  const property = c.create(isPrivate ? 'ClassPrivateProperty' : 'ClassProperty', node.start, node.end)
  property.static = node.static
  if (c.flow) property.variance = null
  property.key = c.convert(node.key)
  if (!isPrivate) property.computed = node.computed
  c.functions++
  property.value = c.maybe(node.value)
  c.functions--
  return c.finish(property)
}

function convertFunction(node, c) {
  c.locate(node)
  if (node.type === 'ArrowFunctionExpression') node.id = null
  delete node.expression
  return fn(node, c, node)
}

function convertStaticBlock(node, c) {
  c.functions++
  c.locate(node)
  node.body = c.list(node.body)
  c.functions--
  return c.finish(node)
}

function convertChain(node, c) {
  c.chains++
  const expression = c.convert(node.expression)
  c.chains--
  chain(expression)
  return expression
}

function convertMember(node, c) {
  c.locate(node)
  node.object = c.convert(node.object)
  node.property = c.convert(node.property)
  if (!node.optional) delete node.optional
  return c.finish(node)
}

function convertCall(node, c) {
  c.locate(node)
  node.callee = c.convert(node.callee)
  node.arguments = c.list(node.arguments)
  const comma = trailingComma(c.code, c.commentStarts, node.end - 1)
  if (comma !== -1) {
    // Babel marks an optional call's otherwise.
    if (node.optional || c.chains > 0) throw new Unconverted('trailing comma')
    node.extra = { trailingComma: comma }
  }
  if (!node.optional) delete node.optional
  return c.finish(node)
}

function convertNew(node, c) {
  c.locate(node)
  node.callee = c.convert(node.callee)
  node.arguments = c.list(node.arguments)
  if (c.flow) node.typeArguments = null
  return c.finish(node)
}

function convertList(node, c) {
  c.locate(node)
  c.list(node.type === 'ObjectExpression' || node.type === 'ObjectPattern' ? node.properties : node.elements)
  const comma = trailingComma(c.code, c.commentStarts, node.end - 1)
  if (comma !== -1) {
    // Babel marks an array pattern's where it was an array first.
    if (node.type === 'ArrayPattern') throw new Unconverted('trailing comma')
    node.extra = { trailingComma: comma }
  }
  return c.finish(node)
}

function convertParenthesized(node, c) {
  const inner = node.expression
  const expression = c.convert(inner)
  // A sequence Babel finishes once past `)`, then ends at its own end.
  if (inner.type === 'SequenceExpression') c.ends.set(expression, node.end)
  expression.extra = { ...expression.extra, parenthesized: true, parenStart: node.start }
  c.finished.push({ around: expression, start: node.start, end: node.end })
  return expression
}

function convertTemplate(node, c) {
  // Its quasis and expressions in turn, as Babel finishes them.
  c.locate(node)
  for (let i = 0; i < node.quasis.length; i++) {
    node.quasis[i] = c.convert(node.quasis[i])
    if (i < node.expressions.length) node.expressions[i] = c.convert(node.expressions[i])
  }
  return c.finish(node)
}

function convertTemplateElement(node, c) {
  c.locate(node)
  // Finished with what closes it: `${`, or the backtick.
  c.ends.set(node, node.end + (node.tail ? 1 : 2))
  return c.finish(node)
}

// Those with no more to them than their children, by key, in order; some
// checked first.
const CHILDREN = {
  ExpressionStatement: ['expression'],
  IfStatement: ['test', 'consequent', 'alternate'],
  ReturnStatement: ['argument'],
  ThrowStatement: ['argument'],
  TryStatement: ['block', 'handler', 'finalizer'],
  CatchClause: ['param', 'body'],
  WhileStatement: ['test', 'body'],
  DoWhileStatement: ['body', 'test'],
  ForStatement: ['init', 'test', 'update', 'body'],
  ForInStatement: ['left', 'right', 'body'],
  ForOfStatement: ['left', 'right', 'body'],
  SwitchStatement: ['discriminant', 'cases'],
  SwitchCase: ['test', 'consequent'],
  LabeledStatement: ['label', 'body'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  WithStatement: ['object', 'body'],
  EmptyStatement: [],
  DebuggerStatement: [],
  VariableDeclaration: ['declarations'],
  VariableDeclarator: ['id', 'init'],
  ClassDeclaration: ['id', 'superClass', 'body'],
  ClassExpression: ['id', 'superClass', 'body'],
  ClassBody: ['body'],
  ThisExpression: [],
  Super: [],
  SpreadElement: ['argument'],
  UnaryExpression: ['argument'],
  UpdateExpression: ['argument'],
  BinaryExpression: ['left', 'right'],
  LogicalExpression: ['left', 'right'],
  AssignmentExpression: ['left', 'right'],
  ConditionalExpression: ['test', 'consequent', 'alternate'],
  SequenceExpression: ['expressions'],
  YieldExpression: ['argument'],
  AwaitExpression: ['argument'],
  TaggedTemplateExpression: ['tag', 'quasi'],
  RestElement: ['argument'],
  AssignmentPattern: ['left', 'right'],
}

const CHECKS = {
  ClassDeclaration: noDecorators,
  ClassExpression: noDecorators,
  // Babel takes an await outside a function for ESM, else for an identifier.
  AwaitExpression: (node, c) => (c.topLevelAwait ||= c.functions === 0),
  ForOfStatement: (node, c) => (c.topLevelAwait ||= node.await && c.functions === 0),
  VariableDeclaration: (node) => {
    if (node.kind !== 'var' && node.kind !== 'let' && node.kind !== 'const') throw new Unconverted(node.kind)
  },
}

// (keys, check) -> a conversion of a node with no more to it than these children.
export const children = (keys, check) => (node, c) => {
  check?.(node, c)
  c.locate(node)
  c.children(node, keys)
  return c.finish(node)
}

export const NODES = new Map([
  ...Object.entries(CHILDREN).map(([type, keys]) => [type, children(keys, CHECKS[type])]),
  ['Identifier', identifier],
  ['Literal', convertLiteral],
  ['PrivateIdentifier', convertPrivateName],
  ['Property', convertProperty],
  ['MethodDefinition', convertMethod],
  ['PropertyDefinition', convertClassProperty],
  ['FunctionDeclaration', convertFunction],
  ['FunctionExpression', convertFunction],
  ['ArrowFunctionExpression', convertFunction],
  ['StaticBlock', convertStaticBlock],
  ['BlockStatement', (node, c) => block(node, c)],
  ['ChainExpression', convertChain],
  ['MemberExpression', convertMember],
  ['CallExpression', convertCall],
  ['NewExpression', convertNew],
  ['ObjectExpression', convertList],
  ['ObjectPattern', convertList],
  ['ArrayExpression', convertList],
  ['ArrayPattern', convertList],
  ['ParenthesizedExpression', convertParenthesized],
  ['TemplateLiteral', convertTemplate],
  ['TemplateElement', convertTemplateElement],
])
