import { metroEdges } from './metro.js'

export function bundleEdges(code, map) {
  const edges = metroEdges(code, map)
  if (!edges) throw new Error('bundleEdges: not a Metro bundle; edges-lite.js reads only those, edges.js reads others')
  return { edges }
}
