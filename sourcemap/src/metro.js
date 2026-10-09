import { parse, walk } from './parser.js'
import { fileWithin, lineStarts, positionOf } from './positions.js'
import { literalSpecifier } from './specifiers.js'

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
// `paths` for lazy imports, keyed by position; null for no list.
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

function defineCall(statement) {
  const call = statement.type === 'ExpressionStatement' ? statement.expression : null
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !DEFINE.test(call.callee.name)) return null
  const [factory, id] = call.arguments
  return isFunction(factory) && literal(id) !== null ? call : null
}

// Each module's file: the section its __d starts in, where that section
// lists one file. Sections come in order and so do the modules, so one
// cursor walks the sections once for the whole bundle.
function fileFinder(map, starts) {
  const sections = map.sections ?? []
  let k = -1
  return (call, factory) => {
    const [line, column] = positionOf(starts, call.start)
    while (k + 1 < sections.length && (sections[k + 1].line < line || (sections[k + 1].line === line && sections[k + 1].column <= column))) k++
    if (sections[k]?.files.length === 1) return sections[k].files[0]
    return fileWithin(map, starts, factory.body.start, factory.body.end)
  }
}

// { modules, edges }: every module the bundle defines, as { id, file, name,
// dependencies } (`name` the path a development bundle spells, else null),
// and an edge for each dependency between two modules whose files the map
// names.
export function metroEdges(code, map) {
  const { program, error } = parse(code, 'js')
  if (!program) throw new Error(`metroEdges: the bundle does not parse: ${error}`)
  const fileOf = fileFinder(map, lineStarts(code))
  const modules = new Map()
  for (const statement of program.body) {
    const call = defineCall(statement)
    if (!call) continue
    const [factory, id, list, verbose] = call.arguments
    const module = { id: literal(id), file: fileOf(call, factory), name: literalSpecifier(verbose), dependencies: dependencyIds(list) ?? inlinedIds(factory) }
    modules.set(module.id, module)
  }
  const edges = []
  for (const module of modules.values()) {
    if (!module.file) continue
    const targets = new Set()
    for (const id of module.dependencies) {
      const to = modules.get(id)?.file
      if (!to || to === module.file || targets.has(to)) continue
      targets.add(to)
      edges.push({ from: module.file, to, kind: 'dependency' })
    }
  }
  return { modules: [...modules.values()], edges }
}
