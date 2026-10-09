import type { Edge } from './edges.js'
import type { SourceMap } from './sourcemap.js'

export type { Edge } from './edges.js'

// edges.js's bundleEdges for Metro's output alone, bundle or map, read
// with no parser; throws for any other.
export function bundleEdges(map: SourceMap, code?: string | null): { edges: Edge[] }
