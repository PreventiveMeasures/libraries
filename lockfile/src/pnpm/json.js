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
import { MAX_LINE, UNWRITTEN } from '../lines.js'
import { YamlError } from '../yaml/error.js'

const MAX_DEPTH = 64
const UNWRITTEN_RAW = new RegExp(`(?![\t\n\r])${UNWRITTEN.source}`, 'u')
const ESCAPES = { __proto__: null, '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }
const INTEGER = /0|[1-9]\d*/uy
const SPACE = /[\t \n\r]*/uy
const WORD = /true|false|null/uy

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

function skip(src) {
  SPACE.lastIndex = src.pos
  SPACE.exec(src.text)
  src.pos = SPACE.lastIndex
}

function expect(src, char, what) {
  skip(src)
  if (src.text[src.pos] !== char) throw fail(src, `expected ${what}, found ${found(src)}`)
  src.pos++
}

const found = (src) => (src.pos < src.text.length ? JSON.stringify(src.text[src.pos]) : 'the end of the document')

function readString(src) {
  let value = ''
  let pos = src.pos + 1
  for (;;) {
    const char = src.text[pos]
    if (char === undefined || char === '\n' || char === '\r') throw fail(src, 'a string with no closing quote')
    if (char === '"') break
    if (char === '\t') throw fail(src, 'a tab in a string, which pnpm writes as "\\t"', pos)
    if (char !== '\\') {
      value += char
      pos++
      continue
    }
    const next = src.text[pos + 1]
    const code = /^u00([01][\da-f])$/u.exec(src.text.slice(pos + 1, pos + 6))?.[1]
    if (next in ESCAPES) {
      value += ESCAPES[next]
      pos += 2
    } else if (code !== undefined && code !== '09' && code !== '0a' && code !== '0d') {
      value += String.fromCodePoint(Number.parseInt(code, 16))
      pos += 6
    } else {
      throw fail(src, `${JSON.stringify(src.text.slice(pos, pos + 6))} is not an escape pnpm writes`, pos)
    }
  }
  src.pos = pos + 1
  return value
}

// Entries up to `close`, each read by `entry`, a comma after each but where
// `close` follows the last.
function readEntries(src, close, entry) {
  src.pos++
  skip(src)
  if (src.text[src.pos] === close) {
    src.pos++
    return
  }
  for (;;) {
    entry()
    skip(src)
    if (src.text[src.pos] === close) break
    expect(src, ',', `"," or "${close}"`)
    skip(src)
    if (src.text[src.pos] === close) break
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
  for (const re of [WORD, INTEGER]) {
    re.lastIndex = src.pos
    const word = re.exec(src.text)?.[0]
    if (word !== undefined && !/[\w.+-]/u.test(src.text[re.lastIndex] ?? '')) {
      src.pos = re.lastIndex
      return JSON.parse(word)
    }
  }
  throw fail(src, `expected a value as pnpm writes one, found ${found(src)}`)
}

// The document `text`, whose first line is the file's line `first`: a
// mapping, and nothing after it but line ends.
export function parseLockfileJson(text, first = 0) {
  const src = scanner(text, first)
  if (text[0] !== '{') throw fail(src, 'expected "{" to open the document')
  const value = readValue(src, 0)
  skip(src)
  if (src.pos !== text.length) throw fail(src, `expected the end of the document, found ${found(src)}`)
  return value
}
