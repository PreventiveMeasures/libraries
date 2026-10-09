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
  if (!isWebpack(map)) return { edges: referenceEdges(program, map, starts) }
  // webpack's table holds its modules apart; those it concatenated into one
  // scope read as any scope-hoisted bundle does.
  const scoped = referenceEdges(program, map, starts).filter((edge) => !isWebpackOwn(edge.from) && !isWebpackOwn(edge.to))
  return { edges: [...webpackEdges(program, map, starts), ...scoped] }
}
