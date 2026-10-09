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
// closing brace.
function paramsOf(line) {
  const end = /\);?\s*$/u.exec(line)?.index
  let found = null
  for (let at = end === undefined ? -1 : line.lastIndexOf('},', end); at >= 0; at = at > 0 ? line.lastIndexOf('},', at - 1) : -1) {
    try {
      const params = JSON.parse(`[${line.slice(at + 2, end)}]`)
      if (!isParams(params)) break
      found = params
    } catch {
      break
    }
  }
  return found
}

// With unstable_inlineDependencyMap, each id stands in the factory's code
// instead, as the argument to its require-shaped parameters.
function inlinedIds(text) {
  const names = /^[\w$]*__d\(\s*(?:function\s*[\w$]*\s*)?\(([^)]*)\)/u.exec(text)?.[1].split(',').slice(1, 4).map((name) => name.trim().replaceAll('$', '\\$'))
  if (!names?.length) return []
  const calls = text.matchAll(new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\((\\d+|"(?:[^"\\\\]|\\\\.)*")[,)]`, 'gu'))
  return [...new Set([...calls].map((call) => JSON.parse(call[1])))]
}

function dependencyIds(list, text) {
  if (Array.isArray(list)) return list
  const ids = Object.entries(list ?? {}).filter(([key]) => /^\d+$/u.test(key)).map(([, id]) => id)
  return ids.length > 0 ? ids : inlinedIds(text)
}

export function metroEdges(code, map) {
  const starts = lineStarts(code)
  const sections = map.sections ?? []
  let section = -1
  const begins = [...code.matchAll(START)].map((match) => match.index)
  const modules = new Map()
  for (const [k, begin] of begins.entries()) {
    const text = code.slice(begin, begins[k + 1])
    let end = text.length
    let params = null
    while (!params && end > 0) {
      const from = text.lastIndexOf('\n', end - 1) + 1
      params = paramsOf(text.slice(from, end))
      if (!params) end = from - 1
    }
    const [line, column] = positionOf(starts, begin)
    if (!params) throw new Error(`metroEdges: the module at line ${line + 1} ends in no define params`)
    // Sections come in order, as the modules do: one cursor walks them once.
    while (sections[section + 1] && (sections[section + 1].line < line || (sections[section + 1].line === line && sections[section + 1].column <= column))) section++
    const file = sections[section]?.files.length === 1 ? sections[section].files[0] : fileWithin(map, starts, begin, begin + end)
    modules.set(params[0], { id: params[0], file, name: params[2] ?? null, dependencies: dependencyIds(params[1], text.slice(0, end)) })
  }
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
  return { modules: [...modules.values()], edges }
}
