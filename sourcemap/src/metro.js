import { edgeList, entryInOrder, indexFiles, languageOf, resolveSpecifier } from './files.js'
import { fileWithin, lineStarts, positionOf, segmentsOf } from './map.js'
import { scanSpecifiers } from './scan.js'

// A Metro bundle, read with no parser: Metro writes each module on lines
// of its own, starting `__d(` (behind the bundle's global prefix, if any),
// and appends the define call's params to its code as JSON:
// `},id[,dependencies[,name]])`, the dependencies the ids its resolver
// picked, or, to carry lazy imports' `paths`, an object keyed by position.

const START = /^[\w$]*__d\(/gmu

const isParams = ([id, dependencies, name, ...rest]) => (typeof id === 'number' || typeof id === 'string')
  && (dependencies === undefined || typeof dependencies === 'object') && (name === undefined || typeof name === 'string') && rest.length === 0

// The longest run of JSON params the line ends with, back to the factory's
// closing brace. Each run starts with an id, so code before it is passed by
// at a glance rather than by a parse that throws.
function paramsOf(line) {
  const end = /\);?\s*$/u.exec(line)?.index
  let found = null
  let at = end === undefined ? -1 : line.lastIndexOf('},', end)
  while (at >= 0 && /[\d"]/u.test(line[at + 2])) {
    let params
    try {
      params = JSON.parse(`[${line.slice(at + 2, end)}]`)
    } catch {
      break
    }
    if (!isParams(params)) break
    found = params
    at = at > 0 ? line.lastIndexOf('},', at - 1) : -1
  }
  return found
}

// With unstable_inlineDependencyMap, each id stands in the factory's code
// instead, as the argument to its require-shaped parameters.
function inlinedIds(text) {
  const names = /^[^(]*\(\s*(?:function\s*[\w$]*\s*)?\(([^)]*)\)/u.exec(text)?.[1].split(',').slice(1, 4).map((name) => name.trim().replaceAll('$', '\\$'))
  if (!names?.length) return []
  const calls = text.matchAll(new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\((\\d+|"(?:[^"\\\\]|\\\\.)*")[,)]`, 'gu'))
  return [...new Set([...calls].map((call) => JSON.parse(call[1])))]
}

function dependencyIds(list, text) {
  if (Array.isArray(list)) return list
  const ids = Object.entries(list ?? {}).filter(([key]) => /^\d+$/u.test(key)).map(([, id]) => id)
  return ids.length > 0 ? ids : inlinedIds(text)
}

// A module with no code mapped to its file (JSON, a bare re-export) has
// the file between its neighbours': Metro lists a file a module, in order.
function fillGaps(list, map) {
  const index = new Map(map.files.map((file, i) => [file, i]))
  const known = list.flatMap((module, k) => (module.file ? [{ k, at: index.get(module.file) }] : []))
  for (let i = 0; i < (known[0]?.k ?? 0); i++) list[i].file = map.files[known[0].at - known[0].k + i] ?? null
  for (const [n, { k, at }] of known.entries()) {
    const next = known[n + 1]
    if (next && next.at - at !== next.k - k) continue
    for (let i = k + 1; i < (next?.k ?? list.length); i++) list[i].file = map.files[at + i - k] ?? null
  }
}

// Null for a bundle with no line that starts a Metro module.
function fromBundle(code, map) {
  const begins = [...code.matchAll(START)].map((match) => match.index)
  if (begins.length === 0) return null
  const starts = lineStarts(code)
  const lineAt = (line) => code.slice(starts[line], starts[line + 1])
  const list = []
  for (const [k, begin] of begins.entries()) {
    // Back from the next module's start, past the run statements after the
    // last one.
    const [first] = positionOf(starts, begin)
    let [line] = positionOf(starts, (begins[k + 1] ?? code.length) - 1)
    let params = paramsOf(lineAt(line))
    while (!params && line > first) params = paramsOf(lineAt(--line))
    if (!params) throw new Error(`bundleEdges: the Metro module at line ${first + 1} ends in no define params`)
    const end = starts[line + 1] ?? code.length
    list.push({ id: params[0], file: fileWithin(map, starts, begin, end), dependencies: dependencyIds(params[1], code.slice(begin, end)) })
  }
  fillGaps(list, map)
  const modules = new Map(list.map((module) => [module.id, module]))
  const { edges, link } = edgeList()
  for (const { file: from, dependencies } of list) {
    for (const id of dependencies) link(from, modules.get(id)?.file, 'dependency')
  }
  return edges
}

// A Metro map with no bundle still says most of what the bundle would. Its
// files come in module order, Metro's depth-first walk from the entry, and
// each one's source names its imports; what Babel adds, its helpers and the
// JSX runtime, shows in the names Metro mapped. What a transform adds or
// drops out of sight of both (React Native's codegen, an inlined
// Platform.OS) is not seen.

const isScript = (file) => file.path !== null && !['json', null].includes(languageOf(file.path))
const isAsset = (file) => file.path !== null && languageOf(file.path) === null

// The helper modules Babel's binding `name` stands for: `_classCallCheck2`
// for one it imports, or one its module transform or JSX imports; the
// `_callSuper` it writes in place calls two it imports.
function helpersOf(name) {
  const imported = /^_([A-Za-z]+)\d+$/u.exec(name)?.[1]
  if (imported) return [imported, 'interopRequireDefault']
  const own = /^_(interopRequire(?:Default|Wildcard)|jsx(?:Dev)?Runtime|callSuper)$/u.exec(name)?.[1]
  if (own === 'callSuper') return ['getPrototypeOf', 'possibleConstructorReturn', 'interopRequireDefault']
  return own ? [own] : []
}

const HELPER_MODULES = { jsxRuntime: 'react/jsx-runtime', jsxDevRuntime: 'react/jsx-dev-runtime' }

// Each file's helper modules, by the names its segments carry; not one a
// prebuilt file declares for itself.
function helperRequests(map) {
  const { sources, names, nameList } = segmentsOf(map)
  const helpers = new Map()
  const shapes = new Map()
  const bindings = map.files.map(() => new Set())
  for (let k = 0; k < names.length; k++) {
    if (names[k] < 0 || sources[k] < 0) continue
    if (!shapes.has(names[k])) shapes.set(names[k], helpersOf(nameList[names[k]]).length > 0)
    if (shapes.get(names[k])) bindings[sources[k]].add(nameList[names[k]])
  }
  for (const [i, named] of bindings.entries()) {
    if (named.size === 0) continue
    const file = map.files[i]
    const declared = new Set(Array.from((file.content ?? '').matchAll(/(?:function|var|let|const)\s+(_[A-Za-z]+)\b/gu), (match) => match[1]))
    const modules = [...named].filter((name) => !declared.has(name.replace(/\d+$/u, ''))).flatMap(helpersOf)
    if (modules.length > 0) helpers.set(file, modules.map((module) => HELPER_MODULES[module] ?? `@babel/runtime/helpers/${module}`))
  }
  return helpers
}

function fromMap(map) {
  if (!map.files.some((file) => /(?:^|\/)__prelude__$/u.test(file.source ?? ''))) return null
  const index = indexFiles(map.files)
  // An asset's one import, the registry, the walk reached right after the
  // first asset; an import() also imports Metro's asyncRequire.
  const registry = map.files[map.files.findIndex(isAsset) + 1]
  const asyncRequire = map.files.find((file) => file.package?.name === 'metro-runtime' && file.package.path === 'src/modules/asyncRequire.js')
  const { edges, link } = edgeList()
  const resolve = (from, specifier) => resolveSpecifier(index, from, specifier, entryInOrder).to
  const helpers = helperRequests(map)
  for (const from of map.files) {
    if (isAsset(from)) link(from, registry, 'dependency')
    if (!from.content || !isScript(from)) continue
    // Metro records no module for a computed request.
    for (const { kind, specifier } of scanSpecifiers(from.content).filter((found) => found.specifier !== null)) {
      link(from, resolve(from, specifier), 'dependency')
      if (kind === 'dynamic-import') link(from, asyncRequire, 'dependency')
    }
    for (const specifier of helpers.get(from) ?? []) link(from, resolve(from, specifier), 'dependency')
  }
  return edges
}

// Metro's edges, from its bundle, or from its map alone where there is no
// `code`; null for neither's.
export const metroEdges = (map, code) => (code == null ? fromMap(map) : fromBundle(code, map))

export function bundleEdges(map, code) {
  const edges = metroEdges(map, code)
  if (!edges) throw new Error(`bundleEdges: not a Metro ${code == null ? 'map' : 'bundle'}; edges-lite.js reads only those, edges.js reads others`)
  return { edges }
}
