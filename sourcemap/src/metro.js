import { parse, walk } from './parser.js'
import { fileAt, fileWithin, lineStarts, positionOf } from './positions.js'

// Metro writes every module as __d(factory, id, dependencies, name), the
// dependencies the ids its resolver picked, minified or not. A section of
// the map starts where each __d does and names the module's one file; with
// no sections (a map composed for Hermes is flat), the file most of the
// factory maps to stands in.

// The define call, by Metro's name or with the global prefix a bundle can
// be given ahead of it.
const DEFINE = /__d$/u

const literal = (node) => (node?.type === 'Literal' && (typeof node.value === 'number' || typeof node.value === 'string') ? node.value : null)
const isFunction = (node) => node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'

// The module ids an argument lists: an array of ids (null for an optional
// one that did not resolve), or the object Metro writes instead to carry
// `paths` for lazy imports, keyed by position.
function dependencyIds(node) {
  if (node?.type === 'ArrayExpression') return node.elements.map((element) => literal(element))
  if (node?.type !== 'ObjectExpression') return null
  const ids = []
  for (const property of node.properties) {
    const key = property.type === 'Property' ? (property.key.type === 'Identifier' ? property.key.name : String(property.key.value)) : null
    if (key !== null && /^\d+$/u.test(key)) ids[Number(key)] = literal(property.value)
  }
  // `paths` alone: the ids were inlined, and only the lazy paths are left.
  return ids.length === 0 ? null : Array.from(ids, (id) => id ?? null)
}

// With unstable_inlineDependencyMap the list is gone and each id stands in
// the code, as the argument to the factory's require-shaped parameters
// (require, importDefault, importAll).
function inlinedIds(factory) {
  const callees = new Set(factory.params.slice(1, 4).filter((param) => param.type === 'Identifier').map((param) => param.name))
  const ids = []
  walk(factory.body, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !callees.has(node.callee.name)) return
    const id = literal(node.arguments[0])
    if (id !== null && !ids.includes(id)) ids.push(id)
  })
  return ids
}

function moduleFile(map, starts, call, factory) {
  if (map.sections) {
    const [line, column] = positionOf(starts, call.start)
    const section = map.sections.findLast((s) => s.line < line || (s.line === line && s.column <= column))
    if (section?.files.length === 1) return section.files[0]
  }
  return fileWithin(map, starts, factory.body.start, factory.body.end) ?? fileAt(map, starts, factory.body.start)
}

function defineCall(statement) {
  const call = statement.type === 'ExpressionStatement' ? statement.expression : null
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !DEFINE.test(call.callee.name)) return null
  const [factory, id] = call.arguments
  return isFunction(factory) && literal(id) !== null ? call : null
}

// { modules, edges }: every module the bundle defines, as { id, file, name,
// dependencies } (`name` the path a development bundle spells, else null),
// and an edge for each dependency between two modules whose files the map
// names.
export function metroEdges(code, map) {
  const { program, error } = parse('bundle.js', code)
  if (!program) throw new Error(`metroEdges: the bundle does not parse: ${error}`)
  const starts = lineStarts(code)
  const modules = new Map()
  for (const statement of program.body) {
    const call = defineCall(statement)
    if (!call) continue
    const [factory, id, list, verbose] = call.arguments
    const listed = dependencyIds(list)
    const dependencies = listed ?? inlinedIds(factory)
    const name = verbose?.type === 'Literal' && typeof verbose.value === 'string' ? verbose.value : null
    modules.set(literal(id), { id: literal(id), file: moduleFile(map, starts, call, factory), name, dependencies })
  }
  const edges = []
  for (const module of modules.values()) {
    const targets = new Set()
    for (const id of module.dependencies) {
      const to = modules.get(id)?.file
      if (!module.file || !to || to === module.file || targets.has(to)) continue
      targets.add(to)
      edges.push({ from: module.file, to, kind: 'dependency' })
    }
  }
  return { modules: [...modules.values()], edges }
}
