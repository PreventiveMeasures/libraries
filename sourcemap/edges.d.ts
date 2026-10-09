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
  path?: string
  package?: string
  builtin?: true
}

export interface ImportEdges {
  // The specifiers each file's own source names, statements typed away
  // (`import type`, `export type`) left out, each once per kind.
  edges: (Edge & { kind: ImportKind; specifier: string | null })[]
  // Files whose content did not parse, oxc's error with each: Flow, or a
  // language oxc does not read.
  failed: { file: SourceFile; error: string }[]
  // Files with no sourcesContent, or not a script by their extension.
  unscanned: SourceFile[]
}

// Each file's sourcesContent parsed (oxc reads JS, TS and JSX by the
// extension, a bundler's `?query` after it aside, and JSX in a .js file
// too), each specifier resolved among the map's files by the names a
// resolver would try: extensions, index files, React Native's platform
// files, TypeScript's output names; a package by the node_modules Node
// would walk up to, or by the one copy of it the map has. Without
// package.json or tsconfig: no `exports`, `main`, or aliases.
export function importEdges(map: SourceMap): ImportEdges

// The edges a bundle shows between the files its map lists. For Metro's
// output (`code`, the JavaScript, not Hermes bytecode), each module's
// dependencies, as Metro resolved them: `dependency` edges. For any other,
// a scope-hoisted bundle (esbuild, rollup): code of one file naming a
// declaration of another, `reference` edges, and the modules the bundle
// leaves to the runtime, as import-kind edges to no file. Throws where the
// bundle does not parse, or a Metro module's define call cannot be read.
export function bundleEdges(code: string, map: SourceMap): { edges: Edge[] }
