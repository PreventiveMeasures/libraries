// importEdges and referenceEdges parse with oxc-parser, an optional peer;
// metroEdges reads Metro's output as text, and edges-lite.js has it alone,
// loading no parser. Typed and described in edges.d.ts.
export { importEdges } from './src/imports.js'
export { metroEdges } from './edges-lite.js'
export { referenceEdges } from './src/references.js'
