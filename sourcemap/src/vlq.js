import { SourceMapError } from './error.js'

// The `mappings` string: lines split by `;`, segments by `,`, each segment
// 1, 4 or 5 base64 VLQs: digits whose bit 32 says another follows, the
// first's lowest bit the sign. A segment's first field restarts at zero on
// every line; the rest run on across lines.

// Each base64 digit's value, `,` 64, `;` 65, anything else 255.
const CODES = new Uint8Array(128).fill(255)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/,;'].entries()) CODES[c.codePointAt(0)] = i

// Appends what `mappings` holds to `segments` ({ starts, columns, sources }):
// each segment's generated column, and its file, `files[source]`, or -1 for
// one that maps to nothing. Its first line goes at generated line `line`,
// shifted by `column`, as an index map places a section. Where in a source
// a segment points, and its name, are read past: what is asked of a map
// here is which file, never where in it.
export function decodeInto(segments, mappings, files, line = 0, column = 0) {
  if (typeof mappings !== 'string') throw new SourceMapError('mappings is not a string')
  const { starts, columns, sources } = segments
  while (starts.length <= line) starts.push(columns.length)
  const state = [0, 0, 0, 0, 0]
  let field = 0
  let value = 0
  let base = 1
  let shift = column
  for (let i = 0; i <= mappings.length; i++) {
    const code = i < mappings.length ? (CODES[mappings.codePointAt(i)] ?? 255) : 65
    if (code < 64) {
      value += (code & 31) * base
      if (code & 32) {
        base *= 32
        if (base > 2 ** 30) throw new SourceMapError(`mappings: a value at ${i} runs past 32 bits`)
        continue
      }
      if (field === 5) throw new SourceMapError(`mappings: a segment of more than 5 fields at ${i}`)
      state[field++] += value % 2 ? (1 - value) / 2 : value / 2
      value = 0
      base = 1
      continue
    }
    if (code === 255) throw new SourceMapError(`mappings: ${JSON.stringify(mappings[i])} at ${i} is not a base64 digit`)
    if (base !== 1) throw new SourceMapError(`mappings: the value before ${i} is cut off`)
    if (field > 0) {
      if (field === 2 || field === 3) throw new SourceMapError(`mappings: a segment of ${field} fields before ${i}`)
      const file = field === 1 ? -1 : files[state[1]]
      if (file === undefined) throw new SourceMapError(`mappings: source ${state[1]} before ${i} is not in sources`)
      if (state[0] < 0) throw new SourceMapError(`mappings: a negative generated column before ${i}`)
      columns.push(state[0] + shift)
      sources.push(file)
      field = 0
    }
    if (code === 65 && i < mappings.length) {
      starts.push(columns.length)
      state[0] = 0
      shift = 0
    }
  }
  return segments
}

// The segments as typed arrays, a large map having millions, line l's at
// [starts[l], starts[l + 1]) and in column order, which neither a
// generator nor sections laid side by side need have kept.
export function seal({ starts, columns, sources }) {
  starts.push(columns.length)
  for (let l = 0; l + 1 < starts.length; l++) {
    const from = starts[l]
    const to = starts[l + 1]
    let k = from + 1
    while (k < to && columns[k - 1] <= columns[k]) k++
    if (k >= to) continue
    const sorted = columns.slice(from, to).map((c, n) => [c, sources[from + n]]).sort((a, b) => a[0] - b[0])
    for (const [n, [c, s]] of sorted.entries()) [columns[from + n], sources[from + n]] = [c, s]
  }
  return { starts: Int32Array.from(starts), columns: Int32Array.from(columns), sources: Int32Array.from(sources) }
}
