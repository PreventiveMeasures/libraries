// foundry.lock exactly as forge writes it, with serde_json's pretty printer:
// objects of strings, two spaces a level, three levels deep, and the file
// ended at the last `}`, where an editor may add line ends. Keys come in any
// order, as forge 1.3.0 and 1.3.1 write them in a hash map's. JSON.parse
// takes more, and reads a key given twice as the last, as forge does and
// some other readers do not.

import { quote } from '../error.js'
import { advance, closeQuote, fail, lines, readJsonString, rest } from '../lines.js'

// Never in a lockfile read here: a control, which serde_json escapes below
// U+0020 and no path or name here may have above; a lone surrogate, which
// is not UTF-8; and a byte order mark, which forge does not read at the
// start, and is unseen anywhere else.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF]/u

// A string as serde_json writes it, which JSON.stringify does too: the
// escapes of `"`, `\` and controls, and no others.
function readString(line, pos, number) {
  if (line[pos] !== '"') throw fail(`expected a string, found ${rest(line, pos)}`, number)
  const end = closeQuote(line, pos, number)
  const raw = line.slice(pos, end)
  const value = readJsonString(raw, number)
  if (!value.isWellFormed()) throw fail(`${quote(raw)} escapes a lone surrogate, which forge does not read`, number)
  return [value, end]
}

// Whether a comma ends the line, as one does an entry but the last.
function readEnd(line, pos, number) {
  if (pos === line.length || (line[pos] === ',' && pos + 1 === line.length)) return pos < line.length
  throw fail(`expected "," or the end of the line, found ${rest(line, pos)}`, number)
}

function readValue(src, pos, indent) {
  const { line, number } = src
  if (line[pos] === '"' || indent > 4) {
    const [value, end] = readString(line, pos, number)
    return [value, readEnd(line, end, number)]
  }
  if (line.startsWith('{}', pos)) return [Object.create(null), readEnd(line, pos + 2, number)]
  if (line[pos] === '{' && pos + 1 === line.length) return readObject(src, indent)
  throw fail(`expected a string or an object, found ${rest(line, pos)}`, number)
}

// An object whose `{` ends the line before, and whose `}` is `indent`
// spaces in; and whether a comma follows that.
function readObject(src, indent) {
  const object = Object.create(null)
  const seen = new Map()
  const inner = ' '.repeat(indent + 2)
  for (let more = true; more;) {
    advance(src)
    const { line, number } = src
    if (line === undefined) throw fail('expected a key, found the end of the file', number + 1)
    if (!line.startsWith(inner) || line[inner.length] === ' ') throw fail(`expected ${inner.length} spaces of indentation and a key`, number)
    const [key, end] = readString(line, inner.length, number)
    if (seen.has(key)) throw fail(`${quote(key)} is a key at line ${seen.get(key) + 1} too`, number)
    seen.set(key, number)
    if (!line.startsWith(': ', end)) throw fail(`expected ": " after ${quote(key)}, found ${rest(line, end)}`, number)
    ;[object[key], more] = readValue(src, end + 2, indent + 2)
  }
  advance(src)
  const { line, number } = src
  const close = `${' '.repeat(indent)}}`
  if (line === undefined) throw fail(`expected ${quote(close)}, closing the object, found the end of the file`, number + 1)
  if (line !== close && line !== `${close},`) throw fail(`expected ${quote(close)}, closing the object, found ${quote(line)}`, number)
  return [object, line !== close]
}

export function readJson(text) {
  const src = lines(text, FORBIDDEN)
  advance(src)
  if (src.line !== '{' && src.line !== '{}') throw fail(`expected "{", or "{}" for no dependencies, found ${src.line === undefined ? 'nothing' : quote(src.line)}`, src.number)
  const [root, comma] = src.line === '{' ? readObject(src, 0) : [Object.create(null), false]
  if (comma) throw fail('a comma after the last "}"', src.number)
  for (advance(src); src.line !== undefined; advance(src)) {
    if (src.line !== '') throw fail(`expected the end of the file after the last "}", found ${quote(src.line)}`, src.number)
  }
  return root
}
