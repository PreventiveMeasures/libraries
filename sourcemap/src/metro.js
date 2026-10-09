import { fileWithin, lineStarts, positionOf } from './positions.js'

// No parser: Metro writes each module on lines of its own, starting `__d(`
// (behind the bundle's global prefix, if any), and appends the define
// call's params to its code as JSON: `},id[,dependencies[,name]])`, the
// dependencies the ids its resolver picked, or, to carry lazy imports'
// `paths`, an object keyed by position.

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
  const known = list.flatMap((module, k) => (module.file ? [[k, index.get(module.file)]] : []))
  for (const [n, [k, at]] of known.entries()) {
    const [next, nextAt] = known[n + 1] ?? [list.length, at + list.length - k]
    if (nextAt - at === next - k) for (let i = k + 1; i < next; i++) list[i].file = map.files[at + i - k] ?? null
  }
}

// Null for a bundle with no line that starts a Metro module.
export function metroEdges(code, map) {
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
  const edges = []
  for (const module of modules.values()) {
    if (!module.file) continue
    const targets = new Set([module.file])
    for (const id of module.dependencies) {
      const to = modules.get(id)?.file
      if (!to || targets.has(to)) continue
      targets.add(to)
      edges.push({ from: module.file, to, kind: 'dependency' })
    }
  }
  return edges
}
