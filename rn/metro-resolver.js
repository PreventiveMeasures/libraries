// Metro's module resolution, run over a tree on disk or in memory with no
// code of the tree run; metro-assets.js builds what an asset resolves to.
// Typed and described in metro-resolver.d.ts.
export { createMetroResolver } from './src/metro/resolve.js'
export { defaults } from './src/metro/defaults.js'
