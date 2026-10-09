// The typed contract for sourcemap.js, hand-written because the package is
// plain JavaScript; edges.d.ts is the other door's. A change to an exported
// signature belongs in the same commit as the change here.

// The package a file lies in, as the last node_modules on its path names
// it. `root` is the package's directory, `path` the file's path inside it.
// `version` where the path spells one: pnpm's store, and bun's and deno's
// on its plan, keep each package under <name>@<version>; a plain
// node_modules does not say.
export interface SourcePackage {
  name: string
  version: string | null
  root: string
  path: string
}

// One distinct entry of the map's `sources`.
export interface SourceFile {
  // The entry as the map lists it, `sourceRoot` in front; null for a null one.
  source: string | null
  // The entry as a /-separated path: webpack:// (named from webpack's
  // context) and file:// dropped, then, unless absolute, resolved against
  // the map's own path where one was given, and normalized; `../` above
  // that is kept. Any other URL, or a bundler's name for something that is
  // no file, as it is. Null for a null entry.
  path: string | null
  package: SourcePackage | null
  // Its sourcesContent entry.
  content: string | null
  // Whether ignoreList (or x_google_ignoreList) names it.
  ignored: boolean
}

// Where a section of an index map starts in the generated code, from zero,
// and the files it lists.
export interface SourceMapSection {
  line: number
  column: number
  files: SourceFile[]
}

export interface SourceMap {
  // One per distinct `sources` string, across every section, in the order
  // first listed.
  files: SourceFile[]
  // An index map's sections, in order; null for a plain map.
  sections: SourceMapSection[] | null
}

export interface ReadOptions {
  // Where the map file is, /-separated, relative to whatever the caller
  // counts from: a package root, a project. Its sources are resolved
  // against it, as the format resolves them against the map's URL.
  path?: string
}

// A map read whole: JSON text (a leading `)]}'` line skipped), its UTF-8
// bytes, or the object JSON.parse made of it.
export function readSourceMap(input: string | Uint8Array | object, options?: ReadOptions): SourceMap

// What readSourceMap throws for a map it cannot read.
export class SourceMapError extends Error {
  name: 'SourceMapError'
}
