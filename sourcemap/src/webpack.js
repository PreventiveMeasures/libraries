import { walk } from './parser.js'
import { fileAfter, fileAt, fileWithin } from './positions.js'
import { bareTarget } from './resolve.js'

// webpack keeps each module apart, as a factory in a table keyed by its id
// (a path in development, a number in production), handed `require` as its
// third parameter; the bundle's own require runs a factory by passing
// itself on to it. An id names its module exactly. ES modules webpack
// concatenates into one scope are left to the scope-hoisted reading.

// webpack's runtime, and its stand-ins for externals, which are no files.
const OWN = /^webpack:\/\/[^/]*\/(?:webpack\/|external )/u
const EXTERNAL = /^webpack:\/\/[^/]*\/external (?:[\w-]+ )?"(.+)"$/u

export const isWebpack = (map) => map.files.some((file) => file.source?.startsWith('webpack://'))
export const isWebpackOwn = (file) => OWN.test(file?.source ?? '')

const isFunction = (node) => node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'
const idOf = (node) => (node?.type === 'Literal' && ['number', 'string'].includes(typeof node.value) ? String(node.value) : undefined)

// Tables of nothing but factories: objects by id (webpack 5, and 4 by
// path), or arrays by index (webpack 4).
function factoriesOf(program) {
  const factories = new Map()
  walk(program, (node) => {
    if (node.type === 'ObjectExpression' && node.properties.length > 0 && node.properties.every((p) => isFunction(p.value) && idOf(p.key) !== undefined)) {
      for (const property of node.properties) factories.set(idOf(property.key), property.value)
    } else if (node.type === 'ArrayExpression' && node.elements.some(Boolean) && node.elements.every((e) => e === null || isFunction(e))) {
      for (const [i, element] of node.elements.entries()) if (element) factories.set(String(i), element)
    }
  })
  return factories
}

// `__webpack_require__`, by any name a minifier gave it: the function that
// passes itself to a factory it looks up, `table[id](…, itself)` or, in
// webpack 4, `table[id].call(…, itself)`.
function requireNames(program) {
  const names = new Set(['__webpack_require__'])
  const isLookup = (callee) => callee.type === 'MemberExpression' && (callee.computed || (callee.property.name === 'call' && callee.object.computed))
  walk(program, (node) => {
    if (node.type !== 'FunctionDeclaration' || !node.id) return
    walk(node.body, (call) => {
      if (call.type === 'CallExpression' && isLookup(call.callee) && call.arguments.some((arg) => arg.name === node.id.name)) names.add(node.id.name)
    })
  })
  return names
}

export function webpackEdges(program, map, starts) {
  const factories = factoriesOf(program)
  const files = new Map([...factories].map(([id, factory]) => [id, fileWithin(map, starts, factory.body.start, factory.body.end)]))
  const edges = []
  const seen = new Map()
  // `to` a module's file, or webpack's stand-in for an external.
  const link = (from, to) => {
    const external = EXTERNAL.exec(to?.source ?? '')?.[1]
    if (!from || !to || to === from || isWebpackOwn(from) || (isWebpackOwn(to) && !external)) return
    const keys = seen.get(from) ?? seen.set(from, new Set()).get(from)
    if (keys.has(external ?? to)) return
    keys.add(external ?? to)
    edges.push(external ? { from, to: null, kind: 'dependency', specifier: external, ...bareTarget(external) } : { from, to, kind: 'dependency' })
  }
  const inside = new Set()
  for (const [id, factory] of factories) {
    const param = factory.params[2]?.name
    walk(factory.body, (node) => {
      if (node.type !== 'CallExpression') return
      inside.add(node)
      if (param && node.callee.name === param && files.has(idOf(node.arguments[0]))) link(files.get(id), files.get(idOf(node.arguments[0])))
    })
  }
  // Calls outside the table, from the modules webpack concatenated, which
  // it writes unmapped, ahead of the module's own code; an external's
  // inlined require it maps to its stand-in.
  const requires = requireNames(program)
  walk(program, (node) => {
    if (node.type !== 'CallExpression' || inside.has(node)) return
    const from = () => fileAfter(map, starts, node.end, isWebpackOwn)
    const id = requires.has(node.callee.name) ? idOf(node.arguments[0]) : undefined
    if (files.has(id)) return link(from(), files.get(id))
    const at = fileAt(map, starts, node.start)
    if (EXTERNAL.test(at?.source ?? '')) link(from(), at)
  })
  return edges
}
