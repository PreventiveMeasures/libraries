import { readSourceMap } from '@preventive/sourcemap'

// What the tests share: maps made by hand, and edges written out as lines.

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function vlq(n) {
  let value = n < 0 ? (-n * 2) + 1 : n * 2
  let out = ''
  do {
    let digit = value % 32
    value = Math.floor(value / 32)
    if (value > 0) digit += 32
    out += DIGITS[digit]
  } while (value > 0)
  return out
}

// A map giving each generated line whole to one file: `owners[i]` the index
// into `sources` line i came from, or [that, an index into `extra.names`]
// for a line that carries a name, or null for a line it says nothing about.
export function lineMap(sources, owners, extra = {}) {
  let [source, line, name] = [0, 0, 0]
  const lines = owners.map((owner, i) => {
    if (owner === null) return ''
    const [file, named] = [owner].flat()
    let segment = vlq(0) + vlq(file - source) + vlq(i - line) + vlq(0)
    if (named !== undefined) segment += vlq(named - name)
    ;[source, line, name] = [file, i, named ?? name]
    return segment
  })
  return { version: 3, sources, mappings: lines.join(';'), ...extra }
}

// Generated code written out as [file, code] lines, each line given to the
// file named with it (null for none): [its map read, code].
export function handWritten(lines) {
  const sources = [...new Set(lines.map(([file]) => file).filter(Boolean))]
  const map = readSourceMap(lineMap(sources, lines.map(([file]) => (file ? sources.indexOf(file) : null))))
  return [map, lines.map(([, code]) => code).join('\n')]
}

// An edge as a line: `from -> to [kind]`, or for a target that is no file
// of the map, what is known of it.
export function show(edge) {
  const target = edge.to?.path ?? `(${[edge.specifier, edge.path && `path ${edge.path}`, edge.package && `package ${edge.package}`, edge.builtin && 'builtin'].filter(Boolean).join(', ')})`
  return `${edge.from.path} -> ${target} [${edge.kind}]`
}

export const shown = (edges) => edges.map(show).toSorted()
