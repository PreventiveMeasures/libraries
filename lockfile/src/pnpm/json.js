// The syntax pnpm 12 writes a lockfile of `lockfileVersion: '13.0'` in:
// JSON, with a comma after the last entry of a collection that spans lines,
// which pnpm reads by blanking such commas and parsing the rest as JSON
// (@pnpm/lockfile, json_document.rs). It is still YAML, in flow style, but
// it is read here as pnpm reads it. A string is held to the escapes pnpm
// writes: `\"`, `\\`, `\n`, `\r`, `\t`, and `\u00xx` for any other control;
// all else raw, where a raw one is not refused before, as yaml/parse.js
// refuses one. A key given twice, which JSON.parse reads as the last and
// pnpm's map readers too, is refused, and so is a comma with no entry
// before it, which pnpm refuses, as it leaves the comma.

import { hex } from '../excerpt.js'
import { MAX_LINE, UNWRITTEN, take } from '../lines.js'
import { YamlError } from '../yaml/error.js'

const MAX_DEPTH = 64
const UNWRITTEN_RAW = new RegExp(`(?![\t\n\r])${UNWRITTEN.source}`, 'u')
const ESCAPES = { __proto__: null, '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }
const ESCAPE = /\\(?:(["\\nrt])|u00([01][\da-f]))/uy
const RUN = /[^"\\\t\n\r]*/uy
const SCALAR = /(?:true|false|null|0|[1-9]\d*)(?![\w.+-])/uy
const SPACE = /[\t \n\r]*/uy

// Where reading is: `pos` in `text`, and the line it is on, from `first`.
function scanner(text, first) {
  const char = UNWRITTEN_RAW.exec(text)?.[0]
  const lineOf = (pos) => first + (text.slice(0, pos).match(/\n/gu)?.length ?? 0)
  if (char !== undefined) throw new YamlError(`${hex(char)} is not allowed`, lineOf(text.indexOf(char)))
  const crlf = text.includes('\r\n')
  if (/\r(?!\n)/u.test(text) || (crlf && /(?<!\r)\n/u.test(text))) throw new YamlError('expected every line to end alike, in LF or CRLF', lineOf(text.search(crlf ? /(?<!\r)\n/u : /\r/u)))
  const long = text.split('\n').findIndex((line) => line.length > MAX_LINE)
  if (long !== -1) throw new YamlError(`a line longer than ${MAX_LINE} characters`, first + long)
  return { text, pos: 0, lineOf }
}

const fail = (src, detail, pos = src.pos) => new YamlError(detail, src.lineOf(pos))
const found = (src) => (src.pos < src.text.length ? JSON.stringify(src.text[src.pos]) : 'the end of the document')
const skip = (src) => take(src, SPACE)

function expect(src, char, what) {
  skip(src)
  if (src.text[src.pos] !== char) throw fail(src, `expected ${what}, found ${found(src)}`)
  src.pos++
}

function readEscape(src) {
  const at = src.pos
  const [, short, code] = take(src, ESCAPE) ?? []
  if (short !== undefined) return ESCAPES[short]
  if (code !== undefined && code !== '09' && code !== '0a' && code !== '0d') return String.fromCodePoint(Number.parseInt(code, 16))
  throw fail(src, `${JSON.stringify(src.text.slice(at, at + 6))} is not an escape pnpm writes`, at)
}

// What is raw a run at a time, up to the closing quote.
function readString(src) {
  src.pos++
  let value = ''
  for (;;) {
    value += take(src, RUN)[0]
    const char = src.text[src.pos]
    if (char === '"') break
    if (char === '\t') throw fail(src, 'a tab in a string, which pnpm writes as "\\t"')
    if (char !== '\\') throw fail(src, 'a string with no closing quote')
    value += readEscape(src)
  }
  src.pos++
  return value
}

// Entries up to `close`, each read by `entry`, a comma after each but where
// `close` follows the last.
function readEntries(src, close, entry) {
  src.pos++
  for (;;) {
    skip(src)
    if (src.text[src.pos] === close) break
    entry()
    skip(src)
    if (src.text[src.pos] === close) break
    expect(src, ',', `"," or "${close}"`)
  }
  src.pos++
}

function readObject(src, depth) {
  const object = Object.create(null)
  readEntries(src, '}', () => {
    if (src.text[src.pos] !== '"') throw fail(src, `expected a key in double quotes, found ${found(src)}`)
    const at = src.pos
    const key = readString(src)
    if (Object.hasOwn(object, key)) throw fail(src, `the key ${JSON.stringify(key)} twice in one mapping`, at)
    expect(src, ':', '":" after a key')
    object[key] = readValue(src, depth + 1)
  })
  return object
}

function readArray(src, depth) {
  const array = []
  readEntries(src, ']', () => array.push(readValue(src, depth + 1)))
  return array
}

function readValue(src, depth) {
  if (depth > MAX_DEPTH) throw fail(src, `nested more than ${MAX_DEPTH} deep`)
  skip(src)
  const char = src.text[src.pos]
  if (char === '{') return readObject(src, depth)
  if (char === '[') return readArray(src, depth)
  if (char === '"') return readString(src)
  const scalar = take(src, SCALAR)?.[0]
  if (scalar === undefined) throw fail(src, `expected a value as pnpm writes one, found ${found(src)}`)
  return JSON.parse(scalar)
}

// The document `text`, whose first line is the file's line `first`, and
// nothing after it but line ends: parse.js reads it where it opens with `{`.
export function parseLockfileJson(text, first = 0) {
  const src = scanner(text, first)
  const value = readValue(src, 0)
  skip(src)
  if (src.pos !== text.length) throw fail(src, `expected the end of the document, found ${found(src)}`)
  return value
}
