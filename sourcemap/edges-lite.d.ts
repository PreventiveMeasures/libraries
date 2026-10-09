import type { Edge } from './edges.js'
import type { SourceMap } from './sourcemap.js'

export type { Edge } from './edges.js'

// edges.js's bundleEdges for Metro's output alone, read as text with no
// parser; throws for a bundle that is not Metro's.
export function bundleEdges(code: string, map: SourceMap): { edges: Edge[] }
