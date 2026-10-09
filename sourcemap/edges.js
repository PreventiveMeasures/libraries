// Import edges between the files a map lists, three ways, each as exact as
// what it reads allows. importEdges and referenceEdges parse with
// oxc-parser, an optional peer dependency: on Node loaded on the first
// call, and without it each throws saying so; a browser bundle takes its
// WASM build (src/oxc.*.js). metroEdges needs no parser.

// From the sources themselves (sourcesContent): what each file imports, as
// written, resolved among the map's files. Any bundler, a flat map for
// Hermes too; a file its bundler dropped is still a target, by its path.
export { importEdges } from './src/imports.js'

// From a Metro bundle and its map: each module's dependency ids, as Metro
// resolved them, read off the text Metro writes. Exact, minified or not.
export { metroEdges } from './src/metro.js'

// From a scope-hoisted bundle (esbuild, rollup) and its map: code of one
// file naming a declaration of another. What is used rather than what is
// imported, and with no sourcesContent needed.
export { referenceEdges } from './src/references.js'
