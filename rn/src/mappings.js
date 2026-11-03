// Source map `mappings`, indexed by line as Metro's LineIndexedMappings does: one pass notes where each line
// starts and the state its segments start from, and a lookup decodes only its line. Also joins maps of pieces.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i++) DIGITS[BASE64.codePointAt(i)] = i
const COMMA = 44
const SEMICOLON = 59

// Reads the segment at `from` into `fields`, its number of fields as fields.count; returns the offset after it.
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
      digit = DIGITS[mappings.codePointAt(at)] ?? -1
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

// originalPositionFor(line1, column0) gives the source index, 1-based line and 0-based column that the
// segment at or before the position on its line maps to, or null.
export function indexMappings(mappings) {
  const starts = [0]
  // The source, line and column each line's first segment is relative to.
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

const vlq = (value) => {
  let rest = value < 0 ? -value * 2 + 1 : value * 2
  let out = ''
  do {
    const digit = rest % 32
    rest = Math.floor(rest / 32)
    out += BASE64[rest > 0 ? digit + 32 : digit]
  } while (rest > 0)
  return out
}

// A map made ready to follow others: where its first segment with a source and its first with a name are,
// whose fields concatMaps() rewrites relative to the map before, and the state where it ends.
export function pieceOf(map) {
  const { mappings } = map
  const fields = [0, 0, 0, 0, 0]
  const state = [0, 0, 0, 0]
  let first = null
  let named = null
  let at = 0
  while (at < mappings.length) {
    const code = mappings.codePointAt(at)
    if (code === COMMA || code === SEMICOLON) {
      at++
      continue
    }
    const start = at
    at = readSegment(mappings, at, fields)
    if (fields.count < 4) continue
    for (let i = 0; i < 3; i++) state[i] += fields[i + 1]
    if (first === null) first = { start, end: at, fields: fields.slice(0, fields.count) }
    if (fields.count >= 5) {
      state[3] += fields[4]
      if (named === null) named = { start, end: at, fields: fields.slice(0, 5) }
    }
  }
  return { sources: map.sources, sourcesContent: map.sourcesContent ?? map.sources.map(() => null), names: map.names ?? [], mappings, first, named, end: first === null ? null : state, lines: mappings.split(';').length }
}

// A piece's segment, its fields from where the map before left them.
function rebased(piece, segment, { sourceAt, nameAt, source, line, column, name }) {
  const fields = [...segment.fields]
  if (segment.start === piece.first.start) [fields[1], fields[2], fields[3]] = [sourceAt + fields[1] - source, fields[2] - line, fields[3] - column]
  if (segment.start === piece.named?.start) fields[4] = nameAt + fields[4] - name
  return fields.map(vlq).join('')
}

// Pieces of code, each on lines of its own, as one map. `pieces`: [{ lines, piece }], `lines` the
// piece's line count and `piece` pieceOf() its map, or null.
export function concatMaps(pieces) {
  const sources = []
  const sourcesContent = []
  const names = []
  const out = []
  // Where the last segment with a source, and the last with a name, left the fields.
  let [source, line, column, name] = [0, 0, 0, 0]
  for (const { lines, piece } of pieces) {
    if (piece === null || piece.first === null) {
      out.push(';'.repeat(lines - 1))
      continue
    }
    const [sourceAt, nameAt] = [sources.length, names.length]
    sources.push(...piece.sources)
    sourcesContent.push(...piece.sourcesContent)
    names.push(...piece.names)
    // Its first segment with a source, and its first with a name (that one or a later one), rebased.
    const from = { sourceAt, nameAt, source, line, column, name }
    let text = piece.mappings.slice(0, piece.first.start) + rebased(piece, piece.first, from)
    if (piece.named === null || piece.named.start === piece.first.start) text += piece.mappings.slice(piece.first.end)
    else text += piece.mappings.slice(piece.first.end, piece.named.start) + rebased(piece, piece.named, from) + piece.mappings.slice(piece.named.end)
    // Exactly its lines: those it maps, and the rest.
    out.push(piece.lines >= lines ? text.split(';').slice(0, lines).join(';') : text + ';'.repeat(lines - piece.lines))
    ;[source, line, column] = [sourceAt + piece.end[0], piece.end[1], piece.end[2]]
    if (piece.named !== null) name = nameAt + piece.end[3]
  }
  return { version: 3, sources, sourcesContent, names, mappings: out.join(';') }
}
