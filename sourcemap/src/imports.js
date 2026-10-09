import { languageOf, parse } from './parser.js'
import { indexFiles, resolveSpecifier } from './resolve.js'
import { scanSpecifiers } from './scan.js'
import { specifiersOf } from './specifiers.js'

function edgeOf(from, { kind, specifier, callee }, index) {
  const named = { from, kind, specifier, ...(callee && { callee }) }
  if (specifier === null) return { ...named, to: null }
  const target = resolveSpecifier(index, from, specifier)
  return target.to === from ? null : { ...named, ...target }
}

// A file oxc does not parse, Flow mostly, is read by the scanner instead.
export function importEdges(map, { callees = [] } = {}) {
  const index = indexFiles(map.files)
  const named = new Set(callees)
  const edges = []
  const failed = []
  const unscanned = []
  for (const from of map.files) {
    const lang = from.path === null ? null : languageOf(from.path)
    if (lang === 'json') continue
    if (lang === null || from.content === null) {
      unscanned.push(from)
      continue
    }
    const { program, error } = parse(from.content, lang)
    if (!program) failed.push({ file: from, error })
    const keys = new Set()
    for (const found of program ? specifiersOf(program, named) : scanSpecifiers(from.content, named)) {
      const key = `${found.kind}\0${found.callee ?? ''}\0${found.specifier}`
      if (keys.has(key)) continue
      keys.add(key)
      const edge = edgeOf(from, found, index)
      if (edge) edges.push(edge)
    }
  }
  return { edges, failed, unscanned }
}
