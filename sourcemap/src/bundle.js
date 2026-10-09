import { importEdges } from './imports.js'
import { metroMapEdges } from './metro-map.js'
import { metroEdges } from './metro.js'
import { parse } from './parser.js'
import { lineStarts } from './positions.js'
import { referenceEdges } from './references.js'
import { isWebpack, isWebpackOwn, webpackEdges } from './webpack.js'

export function bundleEdges(map, code) {
  if (code == null) return { edges: metroMapEdges(map) ?? importEdges(map).edges }
  const metro = metroEdges(code, map)
  if (metro) return { edges: metro }
  const { program, error } = parse(code, 'jsx')
  if (!program) throw new Error(`bundleEdges: the bundle does not parse: ${error}`)
  const starts = lineStarts(code)
  // webpack's runtime, and its stand-ins for externals, are no files.
  const references = referenceEdges(program, map, starts, new Set(map.files.filter(isWebpackOwn)))
  return { edges: isWebpack(map) ? [...webpackEdges(program, map, starts), ...references] : references }
}
