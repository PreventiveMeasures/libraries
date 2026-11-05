// Package.resolved exactly as SwiftPM writes it: version 1 with TSCBasic's
// JSON, `"key": value`, and 2 and 3 with Foundation's JSONEncoder, `"key" :
// value`, each pretty-printed, two spaces a level and the keys of each
// object sorted. The file is ended at the last `}`, where SwiftPM adds a line
// end from 5.6, but on Windows, and an editor may add more. JSON.parse takes
// more, and reads a key given twice as the last, as SwiftPM's JSONDecoder
// does on one platform and not on another.

import { quote } from '../error.js'
import { advance, fail, lines, readJsonString, rest } from '../lines.js'

// Never in a Package.resolved: a control, which both writers escape and no
// field may have; a lone surrogate, which no Swift string holds; and a byte
// order mark, which neither writes.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF]/u

// The deepest a container is in one, in spaces: a pin's state, of version 1.
const DEEPEST = 8

// A string as both write it, which JSON.stringify does too: the escapes of
// `"`, `\` and controls, and no others, `/` among them.
function readString(line, pos, number) {
  const [value, end] = readJsonString(line, pos, number)
  if (!value.isWellFormed()) throw fail(`${quote(line.slice(pos, end))} escapes a lone surrogate, which no Swift string has`, number)
  if (/\p{Cc}/u.test(value)) throw fail(`${quote(line.slice(pos, end))} escapes a control, which no field SwiftPM writes has`, number)
  return [value, end]
}

// Whether a comma ends the line, as one does an entry but the last.
function readEnd(line, pos, number) {
  if (pos === line.length || (line[pos] === ',' && pos + 1 === line.length)) return pos < line.length
  throw fail(`expected "," or the end of the line, found ${rest(line, pos)}`, number)
}

// A value at `pos` of a line `indent` spaces in, and whether a comma
// follows it.
function readValue(src, pos, indent) {
  const { line, number } = src
  if (line[pos] === '"') {
    const [value, end] = readString(line, pos, number)
    return [value, readEnd(line, end, number)]
  }
  if (line.startsWith('null', pos)) return [null, readEnd(line, pos + 4, number)]
  const digits = /^(?:0|[1-9]\d*)/u.exec(line.slice(pos, pos + 20))?.[0]
  if (digits !== undefined) {
    if (!Number.isSafeInteger(Number(digits))) throw fail(`${digits} is past 2^53, of no number SwiftPM writes`, number)
    return [Number(digits), readEnd(line, pos + digits.length, number)]
  }
  if ((line[pos] === '{' || line[pos] === '[') && pos + 1 === line.length) {
    if (indent > DEEPEST) throw fail('a container deeper than any SwiftPM writes', number)
    return line[pos] === '{' ? readObject(src, indent) : readArray(src, indent)
  }
  throw fail(`expected a string, a number, null, or "{" or "[" ending the line, found ${rest(line, pos)}`, number)
}

// What closes a container `indent` spaces in, and whether a comma follows.
function readClose(src, indent, bracket, what) {
  advance(src)
  const { line, number } = src
  const close = `${' '.repeat(indent)}${bracket}`
  if (line === undefined) throw fail(`expected ${quote(close)}, closing the ${what}, found the end of the file`, number + 1)
  if (line !== close && line !== `${close},`) throw fail(`expected ${quote(close)}, closing the ${what}, found ${quote(line)}`, number)
  return line !== close
}

// The next line, which has to be `inner` spaces in and no more, and not the
// end of a container with nothing in it: `empty` says why there is none,
// whichever way it is written, as `]` or `}` at once or after a blank line,
// as TSCBasic writes one.
function advanceTo(src, inner, expected, empty) {
  advance(src)
  const { line, number } = src
  if (line === undefined) throw fail(`expected ${expected}, found the end of the file`, number + 1)
  if (/^ *(?:[\]}],?)?$/u.test(line)) throw fail(empty, number)
  if (!line.startsWith(' '.repeat(inner)) || line[inner] === ' ') throw fail(`expected ${inner} spaces of indentation and ${expected}`, number)
  return line
}

// The separator after a key: `": "` of TSCBasic, `" : "` of JSONEncoder,
// whichever the file's first key has, and the same after every other.
function readColon(src, line, end, key) {
  src.colon ??= [' : ', ': '].find((colon) => line.startsWith(colon, end))
  if (src.colon === undefined) throw fail(`expected ": " or " : " after ${quote(key)}, found ${rest(line, end)}`, src.number)
  if (!line.startsWith(src.colon, end)) throw fail(`expected ${quote(src.colon)} after ${quote(key)}, as after the file's first key, found ${rest(line, end)}`, src.number)
  return end + src.colon.length
}

// An object whose `{` ends a line `indent` spaces in, its keys sorted as
// both writers sort them, each once; and whether a comma follows its `}`.
function readObject(src, indent) {
  const object = Object.create(null)
  let previous
  for (let more = true; more;) {
    const line = advanceTo(src, indent + 2, 'a key', previous === undefined ? 'an empty object, which SwiftPM writes none of' : 'expected a key after ","')
    if (line[indent + 2] !== '"') throw fail(`expected a key, found ${rest(line, indent + 2)}`, src.number)
    const [key, end] = readString(line, indent + 2, src.number)
    if (previous !== undefined && key <= previous) {
      throw fail(key === previous ? `${quote(key)} is the key before too` : `${quote(key)} after ${quote(previous)}, where SwiftPM sorts an object's keys`, src.number)
    }
    previous = key
    ;[object[key], more] = readValue(src, readColon(src, line, end, key), indent + 2)
  }
  return [object, readClose(src, indent, '}', 'object')]
}

// An array whose `[` ends a line `indent` spaces in. The one array of a
// Package.resolved is its pins, which SwiftPM writes none of empty: it
// removes the file instead.
function readArray(src, indent) {
  const array = []
  for (let more = true; more;) {
    advanceTo(src, indent + 2, 'a value', array.length === 0 ? 'an empty array, of no pins, where SwiftPM removes the file instead' : 'expected a value after ","')
    let item
    ;[item, more] = readValue(src, indent + 2, indent + 2)
    array.push(item)
  }
  return [array, readClose(src, indent, ']', 'array')]
}

// The file's top object, and the separator its keys have.
export function readJson(text) {
  const src = lines(text, FORBIDDEN)
  src.colon = undefined
  advance(src)
  if (src.line !== '{') throw fail(`expected "{" alone on the first line, found ${src.line === undefined ? 'nothing' : quote(src.line)}`, src.number)
  const [root, comma] = readObject(src, 0)
  if (comma) throw fail('a comma after the last "}"', src.number)
  for (advance(src); src.line !== undefined; advance(src)) {
    if (src.line !== '') throw fail(`expected the end of the file after the last "}", found ${quote(src.line)}`, src.number)
  }
  return { root, colon: src.colon }
}
