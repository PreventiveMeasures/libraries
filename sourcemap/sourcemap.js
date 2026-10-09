// The package's front door for reading a map: what a generated file was
// built from, file by file, and the package each file lies in. Nothing here
// parses JavaScript; the edges between the files are behind the other door,
// @preventive/sourcemap/edges.js, the one that needs a parser.

// A map, as JSON text, bytes or the object JSON.parse made of it, read into
// its files: one per distinct `sources` entry, an index map's sections laid
// over one another. Throws a SourceMapError for one that is not a map.
export { readSourceMap } from './src/map.js'
export { SourceMapError } from './src/error.js'
