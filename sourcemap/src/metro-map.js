import { languageOf } from './files.js'
import { segmentsOf } from './map.js'
import { edgeList, entryInOrder, indexFiles, resolveSpecifier } from './resolve.js'
import { scanSpecifiers } from './scan.js'

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

export function metroMapEdges(map) {
  if (!map.files.some((file) => /(?:^|\/)__prelude__$/u.test(file.source ?? ''))) return null
  const index = indexFiles(map.files)
  // An asset's one import, the registry, the walk reached right after the
  // first asset; an import() also imports Metro's asyncRequire.
  const registry = map.files[map.files.findIndex(isAsset) + 1]
  const asyncRequire = map.files.find((file) => file.package?.name === 'metro-runtime' && file.package.path === 'src/modules/asyncRequire.js')
  const { edges, add } = edgeList()
  const link = (from, to) => {
    if (to && to !== from) add(from, to, { from, to, kind: 'dependency' })
  }
  const resolve = (from, specifier) => resolveSpecifier(index, from, specifier, entryInOrder).to
  const helpers = helperRequests(map)
  for (const from of map.files) {
    if (isAsset(from)) link(from, registry)
    if (!from.content || !isScript(from)) continue
    // Metro records no module for a computed request.
    for (const { kind, specifier } of scanSpecifiers(from.content).filter((found) => found.specifier !== null)) {
      link(from, resolve(from, specifier))
      if (kind === 'dynamic-import') link(from, asyncRequire)
    }
    for (const specifier of helpers.get(from) ?? []) link(from, resolve(from, specifier))
  }
  return edges
}
