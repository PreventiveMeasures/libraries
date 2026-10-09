import type { Edge } from './edges.js'
import type { SourceMap } from './sourcemap.js'

export type { Edge } from './edges.js'

// edges.js's bundleEdges for Metro's output alone, read as text with no
// parser; throws for a bundle that is not Metro's, and with no `code`.
export function bundleEdges(map: SourceMap, code: string): { edges: Edge[] }
