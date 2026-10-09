import { SourceMapError } from './error.js'
import { packageOf, sourcePath } from './files.js'
import { decodeMappings } from './vlq.js'

// A map's decoded segments, kept off the object a caller holds: each
// generated line's [column, file index, line, column] or [column].
const decoded = new WeakMap()

export const segmentsOf = (map) => decoded.get(map)

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function stringArray(value, field, nullable) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new SourceMapError(`${field} is not an array`)
  for (const item of value) {
    if (!(typeof item === 'string' || (nullable && item === null))) throw new SourceMapError(`${field} holds ${JSON.stringify(item)}`)
  }
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

// One plain (non-index) map: its files, and its segments with each source
// index turned into an index into `files`, which `intern` grows.
function readPlain(json, options, intern) {
  if (json.version !== 3) throw new SourceMapError(`version ${JSON.stringify(json.version)} is not 3`)
  if (json.sourceRoot !== undefined && typeof json.sourceRoot !== 'string') throw new SourceMapError('sourceRoot is not a string')
  const sources = stringArray(json.sources, 'sources', true)
  const contents = stringArray(json.sourcesContent, 'sourcesContent', true)
  const ignored = ignoredOf(json, sources.length)
  const root = json.sourceRoot ? json.sourceRoot.replace(/\/?$/u, '/') : ''
  const indices = sources.map((source, i) => intern(source === null ? null : root + source, contents[i] ?? null, ignored.has(i), options))
  const lines = decodeMappings(json.mappings, sources.length)
  for (const line of lines) for (const segment of line) if (segment.length > 1) segment[1] = indices[segment[1]]
  return { lines, files: [...new Set(indices)] }
}

function makeFile(source, content, ignored, options) {
  if (source === null) return { source, path: null, package: null, content, ignored }
  const path = sourcePath(source, options.path)
  return { source, path, package: packageOf(path), content, ignored }
}

// An index map's sections laid over one another into a single set of lines.
function readSections(json, options, intern) {
  if (json.version !== 3) throw new SourceMapError(`version ${JSON.stringify(json.version)} is not 3`)
  if (!Array.isArray(json.sections)) throw new SourceMapError('sections is not an array')
  const lines = []
  const sections = []
  for (const [i, section] of json.sections.entries()) {
    const { offset, map } = isObject(section) ? section : {}
    if (!isObject(offset) || !Number.isInteger(offset.line) || !Number.isInteger(offset.column) || offset.line < 0 || offset.column < 0) throw new SourceMapError(`sections[${i}].offset is not a line and a column`)
    if (!isObject(map)) throw new SourceMapError(`sections[${i}].map is not a source map`)
    if (map.sections !== undefined) throw new SourceMapError(`sections[${i}].map is an index map itself`)
    const previous = sections.at(-1)
    if (previous && (offset.line < previous.line || (offset.line === previous.line && offset.column < previous.column))) throw new SourceMapError(`sections[${i}] starts before sections[${i - 1}]`)
    const plain = readPlain(map, options, intern)
    for (const [l, line] of plain.lines.entries()) {
      const shift = l === 0 ? offset.column : 0
      const target = (lines[offset.line + l] ??= [])
      for (const segment of line) target.push([segment[0] + shift, ...segment.slice(1)])
    }
    sections.push({ line: offset.line, column: offset.column, files: plain.files })
  }
  for (let l = 0; l < lines.length; l++) lines[l] ??= []
  return { lines, sections }
}

// The map as `text` (JSON) or as the object JSON.parse made of it, with
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
  const files = []
  const bySource = new Map()
  // One file a source string, however many sections or entries list it.
  const intern = (source, content, ignored, opts) => {
    const known = source === null ? undefined : bySource.get(source)
    if (known !== undefined) {
      files[known].content ??= content
      files[known].ignored ||= ignored
      return known
    }
    files.push(makeFile(source, content, ignored, opts))
    if (source !== null) bySource.set(source, files.length - 1)
    return files.length - 1
  }
  const read = json.sections === undefined ? { ...readPlain(json, options, intern), sections: null } : readSections(json, options, intern)
  const map = { files, sections: read.sections && read.sections.map((s) => ({ ...s, files: s.files.map((i) => files[i]) })) }
  decoded.set(map, read.lines)
  return map
}
