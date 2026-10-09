import { SourceMapError } from './error.js'

// `mappings`: lines split by `;`, segments by `,`, each 1, 4 or 5 base64
// VLQs (bit 32 continues a value, the lowest bit of its first digit is the
// sign), the first field relative to the line's previous segment, the rest
// to the map's.

// A digit's value, `,` 64, `;` 65, anything else 255.
const CODES = new Uint8Array(128).fill(255)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/,;'].entries()) CODES[c.codePointAt(0)] = i

function grown(array) {
  const bigger = new Int32Array(array.length * 2)
  bigger.set(array)
  return bigger
}

// Neither a generator nor sections laid side by side need have kept a line
// in column order.
function sortLines(segments) {
  const { starts, columns, sources, names } = segments
  for (let l = 0; l + 1 < starts.length; l++) {
    const [from, to] = [starts[l], starts[l + 1]]
    let k = from + 1
    while (k < to && columns[k - 1] <= columns[k]) k++
    if (k >= to) continue
    const sorted = Array.from(columns.subarray(from, to), (c, n) => [c, sources[from + n], names[from + n]]).sort((a, b) => a[0] - b[0])
    for (const [n, [c, s, m]] of sorted.entries()) [columns[from + n], sources[from + n], names[from + n]] = [c, s, m]
  }
  return segments
}

// Each part's segments, from its generated `line` and `column` on, as an
// index map places a section: their generated columns, files (`files[source]`,
// -1 for none) and names (`names + name`, of its `nameCount`; -1 for none),
// line l's at [starts[l], starts[l + 1]). Where in a source a segment
// points is read past.
export function decodeMappings(parts) {
  const starts = [0]
  let columns = new Int32Array(1024)
  let sources = new Int32Array(1024)
  let names = new Int32Array(1024)
  let count = 0
  for (const { mappings, files, line, column, names: nameBase, nameCount } of parts) {
    if (typeof mappings !== 'string') throw new SourceMapError('mappings is not a string')
    while (starts.length <= line) starts.push(count)
    const state = [0, 0, 0, 0, 0]
    let field = 0
    let value = 0
    let base = 1
    let shift = column
    for (let i = 0; i <= mappings.length; i++) {
      const code = i < mappings.length ? (CODES[mappings.codePointAt(i)] ?? 255) : 64
      if (code < 32) {
        value += code * base
        if (field === 5) throw new SourceMapError(`mappings: a segment of more than 5 fields at ${i}`)
        state[field++] += value % 2 ? (1 - value) / 2 : value / 2
        value = 0
        base = 1
        continue
      }
      if (code < 64) {
        value += (code - 32) * base
        base *= 32
        if (base > 2 ** 30) throw new SourceMapError(`mappings: a value at ${i} runs past 32 bits`)
        continue
      }
      if (code === 255) throw new SourceMapError(`mappings: ${JSON.stringify(mappings[i])} at ${i} is not a base64 digit`)
      if (base !== 1) throw new SourceMapError(`mappings: the value before ${i} is cut off`)
      if (field > 0) {
        if (field === 2 || field === 3) throw new SourceMapError(`mappings: a segment of ${field} fields before ${i}`)
        const file = field === 1 ? -1 : files[state[1]]
        if (file === undefined) throw new SourceMapError(`mappings: source ${state[1]} before ${i} is not in sources`)
        if (state[0] < 0) throw new SourceMapError(`mappings: a negative generated column before ${i}`)
        if (count === columns.length) [columns, sources, names] = [grown(columns), grown(sources), grown(names)]
        columns[count] = state[0] + shift
        sources[count] = file
        names[count++] = field === 5 && state[4] >= 0 && state[4] < nameCount ? nameBase + state[4] : -1
        field = 0
      }
      if (code === 65) {
        starts.push(count)
        state[0] = 0
        shift = 0
      }
    }
  }
  starts.push(count)
  return sortLines({ starts: Int32Array.from(starts), columns: columns.slice(0, count), sources: sources.slice(0, count), names: names.slice(0, count) })
}
