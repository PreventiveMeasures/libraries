// importEdges parses a map's sources, and bundleEdges any but Metro's
// output, with oxc-parser, an optional peer; edges-lite.js has bundleEdges
// for Metro's alone, loading no parser. Typed and described in edges.d.ts.
export { importEdges } from './src/imports.js'
export { bundleEdges } from './src/bundle.js'
