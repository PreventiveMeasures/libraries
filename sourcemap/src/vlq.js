import { SourceMapError } from './error.js'

// The `mappings` string: lines split by `;`, segments by `,`, each segment
// 1, 4 or 5 base64 VLQs. The first field restarts at zero on every line,
// the others run on from the previous segment across lines.

const DIGITS = new Int8Array(128).fill(-1)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) DIGITS[c.codePointAt(0)] = i

const SEMICOLON = 59
const COMMA = 44

// A line's segments put in column order, which a generator need not have
// written them in.
function sortLine(decoded, from, to) {
  const order = Array.from({ length: to - from }, (_, k) => from + k).sort((a, b) => decoded.columns[a] - decoded.columns[b])
  const columns = order.map((k) => decoded.columns[k])
  const sources = order.map((k) => decoded.sources[k])
  decoded.columns.set(columns, from)
  decoded.sources.set(sources, from)
}

// Each segment's generated column and source index (-1 for a segment that
// maps to nothing), line l's segments at [starts[l], starts[l + 1]). Where
// in a source a segment points, and the names, are read past and not kept:
// nothing here asks where, only which file. Typed arrays, as a large map has
// millions of segments.
export function decodeMappings(mappings, sourceCount) {
  if (typeof mappings !== 'string') throw new SourceMapError('mappings is not a string')
  let room = 1
  let lineCount = 1
  for (let i = 0; i < mappings.length; i++) {
    const code = mappings.codePointAt(i)
    if (code === COMMA || code === SEMICOLON) room++
    if (code === SEMICOLON) lineCount++
  }
  const starts = new Int32Array(lineCount + 1)
  const columns = new Int32Array(room)
  const sources = new Int32Array(room)
  let count = 0
  let line = 0
  let column = 0
  let source = 0
  let i = 0
  while (i < mappings.length) {
    const code = mappings.codePointAt(i)
    if (code === COMMA || code === SEMICOLON) {
      if (code === SEMICOLON) {
        starts[++line] = count
        column = 0
      }
      i++
      continue
    }
    let fields = 0
    for (; i < mappings.length && mappings[i] !== ',' && mappings[i] !== ';'; fields++) {
      if (fields === 5) throw new SourceMapError(`mappings: a segment of more than 5 fields at ${i}`)
      // One VLQ: continuation bit 32, sign in the lowest bit of the first
      // digit. No value a map holds needs more than 32 bits.
      let value = 0
      let digit = 32
      for (let shift = 0; digit & 32; shift += 5) {
        if (i >= mappings.length) throw new SourceMapError('mappings: the last value is cut off')
        if (shift > 30) throw new SourceMapError(`mappings: a value before ${i} runs past 32 bits`)
        const c = mappings.codePointAt(i)
        digit = c < 128 ? DIGITS[c] : -1
        if (digit < 0) throw new SourceMapError(`mappings: ${JSON.stringify(mappings[i])} at ${i} is not a base64 digit`)
        value += (digit & 31) * 2 ** shift
        i++
      }
      const delta = value % 2 === 1 ? -Math.floor(value / 2) : value / 2
      if (fields === 0) column += delta
      else if (fields === 1) source += delta
    }
    if (fields !== 1 && fields !== 4 && fields !== 5) throw new SourceMapError(`mappings: a segment of ${fields} fields before ${i}`)
    if (column < 0) throw new SourceMapError(`mappings: a negative generated column before ${i}`)
    if (fields > 1 && (source < 0 || source >= sourceCount)) throw new SourceMapError(`mappings: source ${source} before ${i} is not in sources`)
    columns[count] = column
    sources[count++] = fields === 1 ? -1 : source
  }
  starts[lineCount] = count
  const decoded = { starts, columns: columns.subarray(0, count), sources: sources.subarray(0, count) }
  for (let l = 0; l < lineCount; l++) {
    for (let k = starts[l] + 1; k < starts[l + 1]; k++) {
      if (decoded.columns[k - 1] > decoded.columns[k]) {
        sortLine(decoded, starts[l], starts[l + 1])
        break
      }
    }
  }
  return decoded
}
