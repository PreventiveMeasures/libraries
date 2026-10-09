import { languageOf, parse } from './parser.js'
import { indexFiles, resolveSpecifier } from './resolve.js'
import { specifiersOf } from './specifiers.js'

function edgeOf(from, { kind, specifier }, index) {
  if (specifier === null) return { from, to: null, kind, specifier }
  const target = resolveSpecifier(index, from, specifier)
  return target.to === from ? null : { from, kind, specifier, ...target }
}

export function importEdges(map) {
  const index = indexFiles(map.files)
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
    if (!program) {
      failed.push({ file: from, error })
      continue
    }
    const keys = new Set()
    for (const found of specifiersOf(program)) {
      const key = `${found.kind}\0${found.specifier}`
      if (keys.has(key)) continue
      keys.add(key)
      const edge = edgeOf(from, found, index)
      if (edge) edges.push(edge)
    }
  }
  return { edges, failed, unscanned }
}
