import { isBuiltin } from 'node:module'
import { parse } from './parser.js'
import { fileAt, lineStarts } from './positions.js'
import { packageName } from './resolve.js'
import { resolveReferences } from './scope.js'

// Edges as a scope-hoisted bundle (esbuild, rollup) still shows them: the
// bundler drops the imports and leaves one scope where every module's names
// meet, so code from one file naming a declaration from another is that
// file using the other. What is used, not what is imported: an import kept
// only for its side effects shows nothing, and a re-exporting index file
// none of whose own code is left is passed straight through.

// What a module the bundle leaves to the runtime is: one of Node's own, a
// package, or neither (a chunk of the same build, named by its path).
function externalTarget(specifier) {
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return { builtin: true }
  if (/^\.\.?(?:\/|$)/u.test(specifier) || specifier.startsWith('/')) return {}
  const name = packageName(specifier)
  return name === null ? {} : { package: name }
}

// { edges }: `reference` edges between files of the map, and the modules the
// bundle leaves to the runtime as `import`, `export-from`, `require` and
// `dynamic-import` edges to no file, from the file whose code names them.
export function referenceEdges(code, map) {
  const { program, error } = parse('bundle.js', code)
  if (!program) throw new Error(`referenceEdges: the bundle does not parse: ${error}`)
  const starts = lineStarts(code)
  const at = (node) => fileAt(map, starts, node.start)
  const edges = []
  const seen = new Map()
  const add = (from, key, edge) => {
    const keys = seen.get(from) ?? seen.set(from, new Set()).get(from)
    if (keys.has(key)) return
    keys.add(key)
    edges.push(edge)
  }
  const external = (from, kind, specifier) => {
    if (from) add(from, `${kind}\0${specifier}`, { from, to: null, kind, specifier, ...externalTarget(specifier) })
  }
  resolveReferences(program, {
    reference(identifier, binding, imported) {
      if (binding === null) return
      const from = at(identifier)
      if (imported !== undefined) return external(from, 'import', imported)
      const to = at(binding)
      if (from && to && from !== to) add(from, to, { from, to, kind: 'reference' })
    },
    external: (node, kind, specifier) => external(at(node), kind, specifier),
  })
  return { edges }
}
