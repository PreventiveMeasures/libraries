import { segmentsOf } from './map.js'
import { indexFiles, packageRoot, resolveSpecifier } from './resolve.js'
import { scanSpecifiers } from './scan.js'

// A Metro map with no bundle still says most of what the bundle would. Its
// files come in module order, Metro's depth-first walk from the entry, and
// each one's source names its imports; what Babel adds, its helpers and the
// JSX runtime, shows in the names Metro mapped. What a transform adds or
// drops out of sight of both (React Native's codegen, an inlined
// Platform.OS) is not seen.

const SCRIPT = /\.[cm]?[jt]sx?$/iu
const isAsset = (file) => /\.(?!json$)[\da-z]+$/iu.test(file.path ?? '') && !SCRIPT.test(file.path)

export const isMetroMap = (map) => map.files.some((file) => file.source === '__prelude__')

// [binding, ...modules]: Babel's binding for a helper it imports,
// `_classCallCheck2`, or one its module transform or JSX imports; the
// `_callSuper` it writes in place calls two it imports.
function helpersOf(name) {
  const imported = /^_([A-Za-z]+)\d+$/u.exec(name)?.[1]
  if (imported) return [imported, imported, 'interopRequireDefault']
  const own = /^_(interopRequire(?:Default|Wildcard)|jsx(?:Dev)?Runtime|callSuper)$/u.exec(name)?.[1]
  if (own === 'callSuper') return [own, 'getPrototypeOf', 'possibleConstructorReturn', 'interopRequireDefault']
  return own ? [own, own] : null
}

const HELPER_MODULES = { jsxRuntime: 'react/jsx-runtime', jsxDevRuntime: 'react/jsx-dev-runtime' }

// Each file's helper modules, by the names its segments carry; not one a
// prebuilt file declares for itself.
function helperRequests(map) {
  const { sources, names, nameList } = segmentsOf(map)
  const bindings = new Map()
  for (let k = 0; k < names.length; k++) {
    if (names[k] < 0 || sources[k] < 0) continue
    const file = map.files[sources[k]]
    const ids = bindings.get(file) ?? bindings.set(file, new Set()).get(file)
    ids.add(names[k])
  }
  const helpers = new Map()
  for (const [file, ids] of bindings) {
    const requests = new Set()
    for (const id of ids) {
      const [binding, ...modules] = helpersOf(nameList[id]) ?? []
      if (!binding || new RegExp(`(?:function|var|let|const)\\s+_${binding}\\b`, 'u').test(file.content ?? '')) continue
      for (const module of modules) requests.add(HELPER_MODULES[module] ?? `@babel/runtime/helpers/${module}`)
    }
    if (requests.size > 0) helpers.set(file, requests)
  }
  return helpers
}

// A package's entry, where no index file is it: its first file in module
// order, which the walk reached before what the entry imports.
function firstFiles(map) {
  const first = new Map()
  for (const file of map.files) if (file.package && !first.has(file.package.root)) first.set(file.package.root, file)
  return first
}

export function metroMapEdges(map) {
  if (!isMetroMap(map)) return null
  const index = indexFiles(map.files)
  const first = firstFiles(map)
  // An asset's one import, the registry, the walk reached right after the
  // first asset; an import() also imports Metro's asyncRequire.
  const registry = map.files[map.files.findIndex(isAsset) + 1]
  const asyncRequire = map.files.find((file) => file.package?.name === 'metro-runtime' && file.package.path === 'src/modules/asyncRequire.js')
  const edges = []
  const seen = new Map()
  const link = (from, to) => {
    const targets = seen.get(from) ?? seen.set(from, new Set([from])).get(from)
    if (!to || targets.has(to)) return
    targets.add(to)
    edges.push({ from, to, kind: 'dependency' })
  }
  const resolve = (from, specifier) => {
    const target = resolveSpecifier(index, from, specifier)
    if (target.to || target.package !== specifier) return target.to
    return first.get(packageRoot(index, from, specifier)) ?? null
  }
  const helpers = helperRequests(map)
  for (const from of map.files) {
    if (isAsset(from)) link(from, registry)
    if (!from.content || !SCRIPT.test(from.path ?? '')) continue
    for (const { kind, specifier } of scanSpecifiers(from.content)) {
      link(from, resolve(from, specifier))
      if (kind === 'dynamic-import') link(from, asyncRequire)
    }
    for (const specifier of helpers.get(from) ?? []) link(from, resolve(from, specifier))
  }
  return edges
}
