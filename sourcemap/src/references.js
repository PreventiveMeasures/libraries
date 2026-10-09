import { fileAt } from './positions.js'
import { edgeList, externalEdge } from './resolve.js'
import { resolveReferences } from './scope.js'

// A scope-hoisted bundle (esbuild, rollup) drops the imports and leaves one
// scope where every module's names meet: code from one file naming a
// declaration from another is that file using the other. Code in a file of
// `skip` is no file's.
export function referenceEdges(program, map, starts, skip = new Set()) {
  const at = (node) => {
    const file = fileAt(map, starts, node.start)
    return skip.has(file) ? null : file
  }
  const { edges, add } = edgeList()
  const external = (from, kind, specifier) => {
    if (from) add(from, `${kind}\0${JSON.stringify(specifier)}`, externalEdge(from, kind, specifier))
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
  return edges
}
