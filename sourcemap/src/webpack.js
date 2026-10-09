import { WEBPACK } from './files.js'
import { forEachChild } from './parser.js'
import { fileAfter, fileAt, fileWithin } from './positions.js'
import { edgeList, externalEdge } from './resolve.js'

// webpack keeps each module apart, as a factory in a table keyed by its id
// (a path in development, a number in production), handed `require` as its
// third parameter; the bundle's own require runs a factory by passing
// itself on to it. An id names its module exactly. ES modules webpack
// concatenates into one scope are left to the scope-hoisted reading.

// A webpack:// (or eval devtools' webpack-internal://) source, after its
// namespace; webpack's runtime, and its stand-ins for externals, which are
// no files.
const inWebpack = (file) => (WEBPACK.test(file?.source ?? '') ? file.source.replace(WEBPACK, '') : '')
const externalOf = (file) => /^external (?:[\w-]+ )?"(.+)"$/u.exec(inWebpack(file))?.[1]

export const isWebpack = (map) => map.files.some((file) => WEBPACK.test(file.source ?? ''))
export const isWebpackOwn = (file) => /^(?:webpack\/|external )/u.test(inWebpack(file))

const isFunction = (node) => node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'
const idOf = (node) => (node?.type === 'Literal' && ['number', 'string'].includes(typeof node.value) ? String(node.value) : undefined)

// A table of nothing but factories: an object by id (webpack 5, and 4 by
// path), or an array by index (webpack 4); none for any other node.
function tableOf(node) {
  if (node.type === 'ObjectExpression' && node.properties.length > 0 && node.properties.every((p) => isFunction(p.value) && idOf(p.key) !== undefined)) {
    return node.properties.map((property) => [idOf(property.key), property.value])
  }
  if (node.type === 'ArrayExpression' && node.elements.some(Boolean) && node.elements.every((e) => e === null || isFunction(e))) {
    return node.elements.flatMap((element, i) => (element ? [[String(i), element]] : []))
  }
  return []
}

const isLookup = (callee) => callee.type === 'MemberExpression' && (callee.computed || (callee.property.name === 'call' && callee.object.computed))

// One walk: the tables outside any module (a table in one is the module's
// own), every call with the factory it is in, and `__webpack_require__` by
// any name a minifier gave it: the function that passes itself to a
// factory it looks up, `table[id](…, itself)` or, in webpack 4,
// `table[id].call(…, itself)`.
function read(program) {
  const ids = new Map()
  const factories = new Map()
  const calls = []
  const requires = new Set(['__webpack_require__'])
  const declared = []
  const visit = (node, factory) => {
    for (const [id, fn] of factory ? [] : tableOf(node)) {
      if (ids.has(id)) continue
      ids.set(id, fn)
      factories.set(fn, id)
    }
    if (node.type === 'CallExpression') {
      calls.push([node, factory])
      if (isLookup(node.callee)) for (const argument of node.arguments) if (declared.includes(argument.name)) requires.add(argument.name)
    }
    const name = node.type === 'FunctionDeclaration' ? node.id?.name : undefined
    if (name) declared.push(name)
    forEachChild(node, visit, factories.has(node) ? node : factory)
    if (name) declared.pop()
  }
  visit(program, null)
  return { ids, factories, calls, requires }
}

export function webpackEdges(program, map, starts) {
  const { ids, factories, calls, requires } = read(program)
  const files = new Map([...ids].map(([id, factory]) => [id, fileWithin(map, starts, factory.body.start, factory.body.end)]))
  const { edges, add } = edgeList()
  // `to` a module's file, or webpack's stand-in for an external.
  const link = (from, to) => {
    const external = externalOf(to)
    if (!from || !to || to === from || isWebpackOwn(from) || (isWebpackOwn(to) && !external)) return
    add(from, external ?? to, external ? externalEdge(from, 'dependency', external) : { from, to, kind: 'dependency' })
  }
  // A call outside the table is a concatenated module's, which webpack
  // writes unmapped, ahead of the module's own code; an external's inlined
  // require it maps to its stand-in.
  const after = (call) => fileAfter(map, starts, call.end, isWebpackOwn)
  for (const [call, factory] of calls) {
    const id = idOf(call.arguments[0])
    if (factory) {
      const param = factory.params[2]?.name
      if (param && call.callee.name === param) link(files.get(factories.get(factory)), files.get(id))
    } else if (requires.has(call.callee.name) && files.has(id)) {
      link(after(call), files.get(id))
    } else {
      const at = fileAt(map, starts, call.start)
      if (externalOf(at)) link(after(call), at)
    }
  }
  return edges
}
