import { parse } from './parser.js'
import { indexFiles, resolveSpecifier } from './resolve.js'
import { specifiersOf } from './specifiers.js'

// Import edges as the original sources wrote them: each file's
// sourcesContent parsed, each specifier resolved among the map's files.
// What the sources ask for, not what the bundle kept: an import of a file
// the bundler dropped whole is still an edge, to a path no file has.

const SCRIPT = /\.[cm]?[jt]sx?$/u
const JSON_FILE = /\.json$/u

function edgeOf(from, found, index) {
  const edge = { from, to: null, kind: found.kind, specifier: found.specifier }
  if (found.specifier === null) return edge
  const target = resolveSpecifier(index, from, found.specifier)
  if (target.to === from) return null
  return { ...edge, ...target }
}

// { edges, failed, unscanned }: `failed` the files whose content did not
// parse, each with the parser's error; `unscanned` those with no content to
// parse, or with content that is not a script.
export function importEdges(map) {
  const index = indexFiles(map.files)
  const edges = []
  const failed = []
  const unscanned = []
  for (const from of map.files) {
    // JSON imports nothing, with its content or without.
    if (from.path !== null && JSON_FILE.test(from.path)) continue
    if (from.path === null || from.content === null || !SCRIPT.test(from.path)) {
      unscanned.push(from)
      continue
    }
    const { program, error } = parse(from.path, from.content)
    if (!program) {
      failed.push({ file: from, error })
      continue
    }
    // One edge for a specifier a file names more than once the same way.
    const keys = new Set()
    for (const found of specifiersOf(program)) {
      const edge = edgeOf(from, found, index)
      const key = edge && `${edge.kind}\0${edge.specifier}`
      if (edge === null || keys.has(key)) continue
      keys.add(key)
      edges.push(edge)
    }
  }
  return { edges, failed, unscanned }
}
