import { SourceMapError } from './error.js'

// The `mappings` string: lines split by `;`, segments by `,`, each segment
// 1, 4 or 5 base64 VLQs. The first field restarts at zero on every line,
// the others run on from the previous segment across lines.

const DIGITS = new Int8Array(128).fill(-1)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) DIGITS[c.codePointAt(0)] = i

const SEMICOLON = 59
const COMMA = 44

// One VLQ from `at`: [value, next position]. Continuation bit 32, sign in
// the lowest bit of the first digit. No value a map holds needs more than
// 32 bits, so a longer run is an error rather than a lost precision.
function vlq(mappings, at) {
  let value = 0
  let shift = 0
  for (let i = at; i < mappings.length; i++) {
    const code = mappings.codePointAt(i)
    const digit = code < 128 ? DIGITS[code] : -1
    if (digit < 0) throw new SourceMapError(`mappings: ${JSON.stringify(mappings[i])} at ${i} is not a base64 digit`)
    value += (digit & 31) * 2 ** shift
    if ((digit & 32) === 0) {
      const magnitude = Math.floor(value / 2)
      return [value % 2 === 1 ? -magnitude : magnitude, i + 1]
    }
    shift += 5
    if (shift > 30) throw new SourceMapError(`mappings: a value at ${at} runs past 32 bits`)
  }
  throw new SourceMapError('mappings: the last value is cut off')
}

// Each generated line's segments, as [column, source, line, column] with
// the source an index into `sources`, or [column] for a segment that maps
// to nothing. Names are dropped: nothing here reads them. Sorted by column,
// which a generator need not have done.
export function decodeMappings(mappings, sourceCount) {
  if (typeof mappings !== 'string') throw new SourceMapError('mappings is not a string')
  const lines = [[]]
  const state = [0, 0, 0, 0, 0]
  let segment = []
  let i = 0
  const close = () => {
    if (segment.length === 0) return
    if (segment.length !== 1 && segment.length !== 4 && segment.length !== 5) throw new SourceMapError(`mappings: a segment of ${segment.length} fields before ${i}`)
    if (segment[0] < 0) throw new SourceMapError(`mappings: a negative generated column before ${i}`)
    if (segment.length > 1 && (segment[1] < 0 || segment[1] >= sourceCount)) throw new SourceMapError(`mappings: source ${segment[1]} before ${i} is not in sources`)
    lines.at(-1).push(segment.slice(0, 4))
    segment = []
  }
  while (i < mappings.length) {
    const code = mappings.codePointAt(i)
    if (code === SEMICOLON || code === COMMA) {
      close()
      if (code === SEMICOLON) {
        lines.push([])
        state[0] = 0
      }
      i++
      continue
    }
    const [delta, next] = vlq(mappings, i)
    const field = segment.length
    if (field >= 5) throw new SourceMapError(`mappings: a segment of more than 5 fields at ${i}`)
    state[field] += delta
    segment.push(state[field])
    i = next
  }
  close()
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      if (line[k - 1][0] > line[k][0]) {
        line.sort((a, b) => a[0] - b[0])
        break
      }
    }
  }
  return lines
}
