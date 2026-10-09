import { SourceMapError } from './error.js'
import { packageOf, sourcePath } from './files.js'
import { decodeMappings } from './vlq.js'

// A map's decoded segments (vlq.js), kept off the object a caller holds,
// each segment's source index turned into an index into its `files`.
const decoded = new WeakMap()

export const segmentsOf = (map) => decoded.get(map)

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function stringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new SourceMapError(`${field} is not an array`)
  for (const item of value) if (typeof item !== 'string' && item !== null) throw new SourceMapError(`${field} holds ${JSON.stringify(item)}`)
  return value
}

// The indices `ignoreList` names, or the x_google_ignoreList Chrome read
// before the field had its standard name.
function ignoredOf(json, count) {
  const list = json.ignoreList ?? json.x_google_ignoreList
  if (list === undefined) return new Set()
  if (!Array.isArray(list) || !list.every((i) => Number.isInteger(i) && i >= 0 && i < count)) throw new SourceMapError('ignoreList is not a list of indices into sources')
  return new Set(list)
}

const checkVersion = (json) => {
  if (json.version !== 3) throw new SourceMapError(`version ${JSON.stringify(json.version)} is not 3`)
}

// The files read so far, one per distinct source string however many
// sections or entries list it.
class Files {
  list = []
  #bySource = new Map()

  constructor(mapPath) {
    this.mapPath = mapPath
  }

  intern(source, content, ignored) {
    const known = source === null ? undefined : this.#bySource.get(source)
    if (known !== undefined) {
      this.list[known].content ??= content
      this.list[known].ignored ||= ignored
      return known
    }
    const path = source === null ? null : sourcePath(source, this.mapPath)
    this.list.push({ source, path, package: path === null ? null : packageOf(path), content, ignored })
    if (source !== null) this.#bySource.set(source, this.list.length - 1)
    return this.list.length - 1
  }
}

// One plain (non-index) map: its segments, their sources made indices
// into `files`, and which of those it lists.
function readPlain(json, files) {
  checkVersion(json)
  if (json.sourceRoot !== undefined && typeof json.sourceRoot !== 'string') throw new SourceMapError('sourceRoot is not a string')
  const sources = stringArray(json.sources, 'sources')
  const contents = stringArray(json.sourcesContent, 'sourcesContent')
  const ignored = ignoredOf(json, sources.length)
  const root = json.sourceRoot ? json.sourceRoot.replace(/\/?$/u, '/') : ''
  const indices = sources.map((source, i) => files.intern(source === null ? null : root + source, contents[i] ?? null, ignored.has(i)))
  const segments = decodeMappings(json.mappings, sources.length)
  for (let k = 0; k < segments.sources.length; k++) if (segments.sources[k] >= 0) segments.sources[k] = indices[segments.sources[k]]
  return { segments, indices: [...new Set(indices)] }
}

// Sections, in order and apart, laid over one another into one set of
// segments: a section's first line shifted by its column, the rest as they are.
function merge(parts) {
  let lineCount = 1
  let count = 0
  for (const { line, segments } of parts) {
    lineCount = Math.max(lineCount, line + segments.starts.length - 1)
    count += segments.columns.length
  }
  const merged = { starts: new Int32Array(lineCount + 1), columns: new Int32Array(count), sources: new Int32Array(count) }
  let at = 0
  let next = 0
  for (const { line, column, segments } of parts) {
    for (let l = 0; l < segments.starts.length - 1; l++) {
      while (next <= line + l) merged.starts[next++] = at
      for (let k = segments.starts[l]; k < segments.starts[l + 1]; k++, at++) {
        merged.columns[at] = segments.columns[k] + (l === 0 ? column : 0)
        merged.sources[at] = segments.sources[k]
      }
    }
  }
  while (next <= lineCount) merged.starts[next++] = at
  return merged
}

function readSections(json, files) {
  checkVersion(json)
  if (!Array.isArray(json.sections)) throw new SourceMapError('sections is not an array')
  const parts = []
  for (const [i, section] of json.sections.entries()) {
    const { offset, map } = isObject(section) ? section : {}
    if (!isObject(offset) || !Number.isInteger(offset.line) || !Number.isInteger(offset.column) || offset.line < 0 || offset.column < 0) throw new SourceMapError(`sections[${i}].offset is not a line and a column`)
    if (!isObject(map)) throw new SourceMapError(`sections[${i}].map is not a source map`)
    if (map.sections !== undefined) throw new SourceMapError(`sections[${i}].map is an index map itself`)
    const previous = parts.at(-1)
    if (previous && (offset.line < previous.line || (offset.line === previous.line && offset.column < previous.column))) throw new SourceMapError(`sections[${i}] starts before sections[${i - 1}]`)
    const { segments, indices } = readPlain(map, files)
    parts.push({ line: offset.line, column: offset.column, files: indices.map((k) => files.list[k]), segments })
  }
  return { segments: merge(parts), sections: parts.map(({ line, column, files: listed }) => ({ line, column, files: listed })) }
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
  if (!isObject(json)) throw new SourceMapError('not a JSON object')
  const files = new Files(options.path)
  const read = json.sections === undefined ? { segments: readPlain(json, files).segments, sections: null } : readSections(json, files)
  const map = { files: files.list, sections: read.sections }
  decoded.set(map, read.segments)
  return map
}
