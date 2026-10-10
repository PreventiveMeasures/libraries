// importEdges parses a map's sources, and bundleEdges any but Metro's
// output, or a map with no code but Metro's, with oxc-parser, an optional
// peer; edges-lite.js has bundleEdges for Metro's alone, bundle or map,
// loading no parser. Typed and described in edges.d.ts.
export { bundleEdges, importEdges } from './src/edges.js'
