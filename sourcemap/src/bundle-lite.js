import { metroMapEdges } from './metro-map.js'
import { metroEdges } from './metro.js'

export function bundleEdges(map, code) {
  const edges = code == null ? metroMapEdges(map) : metroEdges(code, map)
  if (!edges) throw new Error(`bundleEdges: not a Metro ${code == null ? 'map' : 'bundle'}; edges-lite.js reads only those, edges.js reads others`)
  return { edges }
}
