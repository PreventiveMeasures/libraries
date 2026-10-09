import { metroEdges } from './metro.js'

export function bundleEdges(map, code) {
  if (code == null) throw new Error('bundleEdges: edges-lite.js reads a Metro bundle\'s code; edges.js reads a map alone')
  const edges = metroEdges(code, map)
  if (!edges) throw new Error('bundleEdges: not a Metro bundle; edges-lite.js reads only those, edges.js reads others')
  return { edges }
}
