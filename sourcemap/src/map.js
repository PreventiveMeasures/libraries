import { SourceMapError } from './error.js'
import { packageOf, sourcePath } from './files.js'
import { decodeInto, seal } from './vlq.js'

// A map's decoded segments (vlq.js), kept off the object a caller holds.
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

// One file a distinct source string, however many sections or entries
// list it: its index in `read.files`.
function intern(read, source, content, ignored) {
  const known = source === null ? undefined : read.bySource.get(source)
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

// A plain (non-index) map, its segments from generated `line` and `column`
// on: the indices of the files it lists. `ignoreList` was Chrome's
// x_google_ignoreList before the field had its standard name.
function readPlain(json, read, line = 0, column = 0) {
  check(json.version === 3, `version ${JSON.stringify(json.version)} is not 3`)
  check(json.sourceRoot === undefined || typeof json.sourceRoot === 'string', 'sourceRoot is not a string')
  const sources = stringArray(json.sources, 'sources')
  const contents = stringArray(json.sourcesContent, 'sourcesContent')
  const ignoreList = json.ignoreList ?? json.x_google_ignoreList ?? []
  check(Array.isArray(ignoreList) && ignoreList.every((i) => Number.isInteger(i) && i >= 0 && i < sources.length), 'ignoreList is not a list of indices into sources')
  const ignored = new Set(ignoreList)
  const root = json.sourceRoot ? json.sourceRoot.replace(/\/?$/u, '/') : ''
  const files = sources.map((source, i) => intern(read, source === null ? null : root + source, contents[i] ?? null, ignored.has(i)))
  decodeInto(read.segments, json.mappings, files, line, column)
  return files
}

// An index map's sections, each laid where its offset puts it: in order,
// and no nesting.
function readSections(json, read) {
  check(json.version === 3, `version ${JSON.stringify(json.version)} is not 3`)
  check(Array.isArray(json.sections), 'sections is not an array')
  return json.sections.map((section, i) => {
    const { offset, map } = isObject(section) ? section : {}
    check(isObject(offset) && [offset.line, offset.column].every((n) => Number.isInteger(n) && n >= 0), `sections[${i}].offset is not a line and a column`)
    check(isObject(map) && map.sections === undefined, `sections[${i}].map is not a plain source map`)
    const previous = json.sections[i - 1]?.offset
    check(!previous || previous.line < offset.line || (previous.line === offset.line && previous.column <= offset.column), `sections[${i}] starts before sections[${i - 1}]`)
    const files = readPlain(map, read, offset.line, offset.column)
    return { line: offset.line, column: offset.column, files: [...new Set(files)].map((k) => read.files[k]) }
  })
}

// The map as JSON text, its bytes, or the object JSON.parse made of it, with
// `options.path` where the map file is, to resolve its sources against.
export function readSourceMap(input, options = {}) {
  if (!isObject(options)) throw new TypeError('readSourceMap: options is not an object')
  if (options.path !== undefined && typeof options.path !== 'string') throw new TypeError('readSourceMap: options.path is not a string')
  let json = input
  if (typeof input === 'string' || input instanceof Uint8Array) {
    try {
      const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
      json = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/u, ''))
    } catch (cause) {
      throw new SourceMapError(`not JSON: ${cause.message}`, { cause })
    }
  }
  check(isObject(json), 'not a JSON object')
  const read = { files: [], bySource: new Map(), mapPath: options.path, segments: { starts: [0], columns: [], sources: [] } }
  let sections = null
  if (json.sections === undefined) readPlain(json, read)
  else sections = readSections(json, read)
  const map = { files: read.files, sections }
  decoded.set(map, seal(read.segments))
  return map
}
