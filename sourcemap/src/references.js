import { parse } from './parser.js'
import { fileAt, lineStarts } from './positions.js'
import { bareTarget } from './resolve.js'
import { resolveReferences } from './scope.js'

// A scope-hoisted bundle (esbuild, rollup) drops the imports and leaves one
// scope where every module's names meet: code from one file naming a
// declaration from another is that file using the other.
export function referenceEdges(code, map) {
  const { program, error } = parse(code, 'js')
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
    if (from) add(from, `${kind}\0${specifier}`, { from, to: null, kind, specifier, ...bareTarget(specifier) })
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
