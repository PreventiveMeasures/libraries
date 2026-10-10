import { packageOf, sourcePath } from './files.js'

export class SourceMapError extends Error {
  name = 'SourceMapError'
}

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
function decodeMappings(parts) {
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

// Kept off the object a caller holds.
const decoded = new WeakMap()

export const segmentsOf = (map) => decoded.get(map)

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function check(ok, message) {
  if (!ok) throw new SourceMapError(message)
}

function stringArray(value, field) {
  if (value === undefined) return []
  check(Array.isArray(value), `${field} is not an array`)
  for (const item of value) check(typeof item === 'string' || item === null, `${field} holds ${JSON.stringify(item)}`)
  return value
}

// One file a source string, however many sections or entries list it.
function intern(read, source, content, ignored) {
  const known = read.bySource.get(source)
  if (known !== undefined) {
    read.files[known].content ??= content
    read.files[known].ignored ||= ignored
    return known
  }
  const path = source === null ? null : sourcePath(source, read.mapPath)
  read.files.push({ source, path, package: path === null ? null : packageOf(path), content, ignored })
  if (source !== null) read.bySource.set(source, read.files.length - 1)
  return read.files.length - 1
}

// x_google_ignoreList is what Chrome read before ignoreList was standard.
function readPlain(json, read, line, column) {
  check(json.version === 3, `version ${JSON.stringify(json.version)} is not 3`)
  check(json.sourceRoot === undefined || typeof json.sourceRoot === 'string', 'sourceRoot is not a string')
  const sources = stringArray(json.sources, 'sources')
  const contents = stringArray(json.sourcesContent, 'sourcesContent')
  const ignoreList = json.ignoreList ?? json.x_google_ignoreList ?? []
  check(Array.isArray(ignoreList) && ignoreList.every((i) => Number.isInteger(i) && i >= 0 && i < sources.length), 'ignoreList is not a list of indices into sources')
  const ignored = new Set(ignoreList)
  const root = json.sourceRoot ? json.sourceRoot.replace(/\/?$/u, '/') : ''
  const files = sources.map((source, i) => intern(read, source === null ? null : root + source, contents[i] ?? null, ignored.has(i)))
  const names = Array.isArray(json.names) ? json.names : []
  read.parts.push({ mappings: json.mappings, files, line, column, names: read.names.length, nameCount: names.length })
  read.names.push(...names)
}

function readSections(json, read) {
  check(json.version === 3, `version ${JSON.stringify(json.version)} is not 3`)
  check(Array.isArray(json.sections), 'sections is not an array')
  for (const [i, section] of json.sections.entries()) {
    const { offset, map } = isObject(section) ? section : {}
    check(isObject(offset) && [offset.line, offset.column].every((n) => Number.isInteger(n) && n >= 0), `sections[${i}].offset is not a line and a column`)
    check(isObject(map) && map.sections === undefined, `sections[${i}].map is not a plain source map`)
    const previous = json.sections[i - 1]?.offset
    check(!previous || previous.line < offset.line || (previous.line === offset.line && previous.column <= offset.column), `sections[${i}] starts before sections[${i - 1}]`)
    readPlain(map, read, offset.line, offset.column)
  }
}

export function readSourceMap(input, options = {}) {
  if (!isObject(options)) throw new TypeError('readSourceMap: options is not an object')
  if (options.path !== undefined && typeof options.path !== 'string') throw new TypeError('readSourceMap: options.path is not a string')
  let json = input
  if (typeof input === 'string' || input instanceof Uint8Array) {
    try {
      const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
      // A leading `)]}'` line guards a map against being run as a script.
      json = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/u, ''))
    } catch (cause) {
      throw new SourceMapError(`not JSON: ${cause.message}`, { cause })
    }
  }
  check(isObject(json), 'not a JSON object')
  const read = { files: [], bySource: new Map(), mapPath: options.path, parts: [], names: [] }
  if (json.sections === undefined) readPlain(json, read, 0, 0)
  else readSections(json, read)
  const map = { files: read.files }
  decoded.set(map, { ...decodeMappings(read.parts), nameList: read.names })
  return map
}

// Positions in generated code: the parser's offsets and the map's columns
// both count UTF-16 code units. A line ends at JavaScript's line breaks, by
// which an engine numbers a stack frame's line; the format leaves them to
// the generated code's language.
const BREAK = /\r\n?|[\n\u2028\u2029]/gu

export function lineStarts(code) {
  const starts = [0]
  for (const match of code.matchAll(BREAK)) starts.push(match.index + match[0].length)
  return starts
}

// The last index of sorted `array[lo..hi)` at or before `value`, or lo - 1.
function lastAtOrBefore(array, lo, hi, value) {
  let [low, high] = [lo, hi]
  while (low < high) {
    const mid = (low + high) >> 1
    if (array[mid] <= value) low = mid + 1
    else high = mid
  }
  return low - 1
}

export function positionOf(starts, offset) {
  const line = lastAtOrBefore(starts, 0, starts.length, offset)
  return [line, offset - starts[line]]
}

// As a debugger reads a frame: the last segment on the line at or before
// the column, or -1.
function segmentAt(segments, [line, column]) {
  if (line >= segments.starts.length - 1) return -1
  const from = segments.starts[line]
  const found = lastAtOrBefore(segments.columns, from, segments.starts[line + 1], column)
  return found < from ? -1 : found
}

export function fileAt(map, starts, offset) {
  const segments = segmentsOf(map)
  const found = segmentAt(segments, positionOf(starts, offset))
  return found < 0 || segments.sources[found] < 0 ? null : map.files[segments.sources[found]]
}

// The file of the first segment from `offset` on that names one `skip`
// does not pass over.
export function fileAfter(map, starts, offset, skip) {
  const segments = segmentsOf(map)
  const [first, column] = positionOf(starts, offset)
  if (first >= segments.starts.length - 1) return null
  const from = lastAtOrBefore(segments.columns, segments.starts[first], segments.starts[first + 1], column - 1) + 1
  for (let k = from; k < segments.columns.length; k++) {
    const file = map.files[segments.sources[k]]
    if (file && !skip(file)) return file
  }
  return null
}

// The file most segments over [start, end) name, counting the one `start`
// falls under.
export function fileWithin(map, starts, start, end) {
  const segments = segmentsOf(map)
  const first = positionOf(starts, start)
  const [last, lastColumn] = positionOf(starts, end)
  const counts = new Map()
  const covering = segmentAt(segments, first)
  for (let line = first[0]; line <= last && line < segments.starts.length - 1; line++) {
    const from = line === first[0] && covering >= 0 ? covering : segments.starts[line]
    for (let k = from; k < segments.starts[line + 1]; k++) {
      const source = segments.sources[k]
      if (line === last && segments.columns[k] >= lastColumn) break
      if (source >= 0) counts.set(source, (counts.get(source) ?? 0) + 1)
    }
  }
  const [best] = [...counts].reduce((top, entry) => (entry[1] > top[1] ? entry : top), [-1, 0])
  return best < 0 ? null : map.files[best]
}
