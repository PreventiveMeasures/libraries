// The typed contract for edges.js, hand-written because the package is
// plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { SourceFile, SourceMap } from './sourcemap.js'

export type ImportKind = 'import' | 'export-from' | 'require' | 'dynamic-import'

// An edge from one file of a map. `to` is the file it leads to, or null
// where no file of the map is that target; then what is known of it:
// `path` for a path specifier, relative, `/`-led or a URL (resolved from
// the importing file, as written), `package` for a bare one naming a
// package, `builtin` for one of Node's own modules.
export interface Edge {
  from: SourceFile
  to: SourceFile | null
  kind: ImportKind | 'dependency' | 'reference'
  // The specifier as written; null for a computed one.
  specifier?: string | null
  // For a call of a function importEdges' `callees` names, its name.
  callee?: string
  path?: string
  package?: string
  builtin?: true
}

export interface ImportEdges {
  // The specifiers each file's own source names, statements typed away
  // (`import type`, `export type`) left out, each once per kind.
  edges: (Edge & { kind: ImportKind; specifier: string | null })[]
  // Files whose content oxc did not parse, its error with each: Flow,
  // mostly. Their imports are read with no parser instead.
  failed: { file: SourceFile; error: string }[]
  // Files with no sourcesContent, or not a script by their extension; one
  // named with none, a bin script, is read as one.
  unscanned: SourceFile[]
}

export interface ImportOptions {
  // Functions that take a module's name as require does, whose calls are
  // read as `require` edges with a `callee`: `internalBinding`.
  callees?: string[]
}

// Each file's sourcesContent parsed (oxc reads JS, TS and JSX by the
// extension, a bundler's `?query` after it aside, and JSX in a .js file
// too), each specifier resolved among the map's files by the names a
// resolver would try: extensions, index files, platform files (those of
// the React Native platform the map's files show, a browser or Node
// build, in place of a written extension too),
// TypeScript's output names; a package by the node_modules Node would walk
// up to, or by the one copy of it the map has. With no package.json, a
// package's entry where no index file is is guessed: index, main, browser
// or node, at its root or in src/, lib/, dist/ or build/, else its one
// file; and a compiled package's subpath, lib/a.js, is its source where
// the map holds that, src/a.ts. No `exports`, and no aliases.
export function importEdges(map: SourceMap, options?: ImportOptions): ImportEdges

// The edges a bundle shows between the files its map lists. With no `code`,
// a Metro map's own: each file's imports, read from its source with no
// parser (Flow too), and what Babel adds, its helpers and JSX runtime, by
// the names Metro mapped; the files' order, Metro's walk from the entry,
// gives a package's entry and an asset's registry. That misses what a
// transform alone adds or drops: React Native's codegen imports, an
// import of Platform Metro inlined away. Any other map's, as importEdges
// reads them. For Metro's
// output (`code`, the JavaScript, not Hermes bytecode), each module's
// dependencies, as Metro resolved them: `dependency` edges. For webpack's
// (4 and 5, by its webpack:// sources), each module's require calls by
// id: `dependency` edges, an external's to no file. Otherwise, and for the
// modules webpack concatenates, a scope-hoisted bundle (esbuild, rollup):
// code of one file naming a declaration of another, `reference` edges, and
// the modules the bundle leaves to the runtime, as import-kind edges to no
// file. Throws where the bundle does not parse, or a Metro module's define
// call cannot be read.
export function bundleEdges(map: SourceMap, code?: string | null): { edges: Edge[] }
