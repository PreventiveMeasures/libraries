// A source map's `mappings`, indexed by line as Metro's LineIndexedMappings
// indexes them: one pass keeps where each line starts and the state its
// segments start from; a lookup decodes the one line it needs.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i++) DIGITS[BASE64.codePointAt(i)] = i
const COMMA = 44
const SEMICOLON = 59

// Reads the segment at `from` into `fields`; -> the offset after it, and
// the number of its fields as fields.count.
function readSegment(mappings, from, fields) {
  let at = from
  let count = 0
  while (at < mappings.length) {
    const code = mappings.codePointAt(at)
    if (code === COMMA || code === SEMICOLON) break
    let value = 0
    let shift = 0
    let digit
    do {
      const char = at < mappings.length ? mappings.codePointAt(at) : 128
      digit = char < 128 ? DIGITS[char] : -1
      if (digit === -1) throw new SyntaxError(`mappings: bad VLQ at ${at}`)
      value += (digit & 31) * 2 ** shift
      shift += 5
      at++
    } while (digit & 32)
    if (count < fields.length) fields[count] = value % 2 === 1 ? -(value - 1) / 2 : value / 2
    count++
  }
  fields.count = count
  return at
}

// -> { originalPositionFor(line1, column0) }: the source index, 1-based line
// and 0-based column the segment at or before the position on its line maps
// to; null where none does.
export function indexMappings(mappings) {
  const starts = [0]
  // The source, its line and its column each line's first segment is relative to.
  const states = [0, 0, 0]
  const fields = [0, 0, 0, 0, 0]
  let [source, line, column] = [0, 0, 0]
  let at = 0
  while (at < mappings.length) {
    const code = mappings.codePointAt(at)
    if (code === SEMICOLON) {
      at++
      starts.push(at)
      states.push(source, line, column)
    } else if (code === COMMA) {
      at++
    } else {
      at = readSegment(mappings, at, fields)
      if (fields.count >= 4) [source, line, column] = [source + fields[1], line + fields[2], column + fields[3]]
    }
  }
  return {
    originalPositionFor(line1, column0) {
      const index = line1 - 1
      if (!Number.isInteger(index) || index < 0 || index >= starts.length) return null
      const end = index + 1 < starts.length ? starts[index + 1] - 1 : mappings.length
      let [s, l, c] = states.slice(index * 3, index * 3 + 3)
      let generated = 0
      let found = null
      for (let pos = starts[index]; pos < end;) {
        if (mappings.codePointAt(pos) === COMMA) {
          pos++
          continue
        }
        pos = readSegment(mappings, pos, fields)
        generated += fields[0]
        if (fields.count >= 4) [s, l, c] = [s + fields[1], l + fields[2], c + fields[3]]
        if (generated > column0) break
        found = fields.count >= 4 ? { source: s, line1: l + 1, column0: c } : null
      }
      return found
    },
  }
}
