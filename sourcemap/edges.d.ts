// The typed contract for edges.js, hand-written because the package is
// plain JavaScript. A change to an exported signature belongs in the same
// commit as the change here.

import type { SourceFile, SourceMap } from './sourcemap.js'

export type ImportKind = 'import' | 'export-from' | 'require' | 'dynamic-import'

// An edge from one file of a map. `to` is the file it leads to, or null
// where no file of the map is that target; then what is known of it:
// `path` for a relative specifier (resolved from the importing file, as
// written), `package` for a bare one naming a package, `builtin` for one
// of Node's own modules.
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
// extension, and JSX in a .js file too), each specifier resolved among the
// map's files by the names a resolver would try: extensions, index files,
// React Native's platform files, TypeScript's output names; a package by
// the node_modules Node would walk up to, or by the one copy of it the map
// has. Without package.json or tsconfig: no `exports`, `main`, or aliases.
export function importEdges(map: SourceMap): ImportEdges

export interface MetroModule {
  id: number | string
  // The map's file for it: the section its __d starts in, else the file
  // most of its factory maps to.
  file: SourceFile | null
  // The path a development bundle passes as the fourth argument.
  name: string | null
  // The ids it depends on, in order; null for an optional one that did not
  // resolve.
  dependencies: (number | string | null)[]
}

// Every module a Metro bundle defines (`code`, the JavaScript, not Hermes
// bytecode), and an edge for each of its dependencies between two modules
// whose files the map names. Throws where the bundle does not parse.
export function metroEdges(code: string, map: SourceMap): { modules: MetroModule[]; edges: (Edge & { kind: 'dependency'; to: SourceFile })[] }

// From a scope-hoisted bundle: `reference` edges, code mapped to one file
// naming a declaration mapped to another; and, as import-kind edges to no
// file, the modules the bundle leaves to the runtime (externals), from the
// file whose code names them. Throws where the bundle does not parse.
export function referenceEdges(code: string, map: SourceMap): { edges: Edge[] }
