// A git config file, .gitmodules here, as config.c reads it to the character:
// sections, keys and values, comments, quotes, escapes, and a backslash that
// runs a value on to the next line. What it holds is for gitmodules.js.

import { LockfileError, quote } from '../error.js'

// git's own ctype, ASCII alone: only these are space, and a key is letters,
// digits and `-`, starting with a letter.
const SPACE = new Set([' ', '\t', '\n', '\r'])
const isAlpha = (char) => /^[A-Za-z]$/u.test(char)
const isKeyChar = (char) => /^[\dA-Za-z-]$/u.test(char)
const ESCAPES = { __proto__: null, t: '\t', b: '\b', n: '\n', '\\': '\\', '"': '"' }

// git's get_next_char: CRLF is a line end, a lone CR is space, and the end
// of the file a last line end, read again at every call after. `at` is the
// line of the character last read.
function cursor(text, where) {
  let pos = 0
  let line = 0
  const src = { at: 0, eof: false }
  src.next = () => {
    src.at = line
    if (pos >= text.length) {
      src.eof = true
      return '\n'
    }
    let char = text[pos++]
    if (char === '\r' && text[pos] === '\n') char = text[pos++]
    if (char === '\n') line++
    return char
  }
  src.fail = (detail) => new LockfileError(`${detail} at line ${src.at + 1}`, where)
  return src
}

// `[name]` or `[name "subsection"]`; the name lowercased, the subsection with
// a backslash's character for it.
function readHeader(src) {
  let name = ''
  for (;;) {
    const char = src.next()
    if (src.eof) throw src.fail('a section with no closing "]"')
    if (char === ']') break
    if (SPACE.has(char)) return [name, readSubsection(src, char)]
    if (!isKeyChar(char) && char !== '.') throw src.fail(`${quote(char)} in the name of a section`)
    name += char.toLowerCase()
  }
  if (name === '') throw src.fail('a section with no name')
  return [name, undefined]
}

function readSubsection(src, first) {
  let char = first
  do {
    if (char === '\n') throw src.fail('a section header that runs past its line')
    char = src.next()
  } while (SPACE.has(char))
  if (char !== '"') throw src.fail(`expected a quoted subsection after the name of the section, found ${quote(char)}`)
  let subsection = ''
  for (char = src.next(); char !== '"'; char = src.next()) {
    if (char === '\\') char = src.next()
    if (char === '\n') throw src.fail('a subsection with no closing quote')
    subsection += char
  }
  if (src.next() !== ']') throw src.fail('expected "]" after the subsection')
  return subsection
}

// git's parse_value. Space within a value and outside quotes is read as one
// space a character by git before 2.45, and as itself since: a tab or CR
// there is refused, read two ways.
function readValue(src) {
  let value = ''
  let quoted = false
  let comment = false
  let space = ''
  for (;;) {
    let char = src.next()
    if (char === '\n') {
      if (quoted) throw src.fail('a value with no closing quote')
      return value
    }
    if (comment) continue
    if (SPACE.has(char) && !quoted) {
      if (value !== '') space += char
      continue
    }
    if (!quoted && (char === '#' || char === ';')) {
      comment = true
      continue
    }
    const other = /[^ ]/u.exec(space)?.[0]
    if (other !== undefined) throw src.fail(`${quote(other)} within a value, which git reads as a space before 2.45 and as itself since`)
    value += space
    space = ''
    if (char === '\\') {
      char = src.next()
      if (char === '\n') continue
      if (!(char in ESCAPES)) throw src.fail(`${quote(`\\${char}`)}, an escape git does not read`)
      value += ESCAPES[char]
    } else if (char === '"') {
      quoted = !quoted
    } else {
      value += char
    }
  }
}

// git's get_value: a key alone is `null`, which git reads as true.
function readEntry(src, first) {
  const line = src.at
  let key = first.toLowerCase()
  let char = src.next()
  for (; !src.eof && isKeyChar(char); char = src.next()) key += char.toLowerCase()
  while (char === ' ' || char === '\t') char = src.next()
  if (char === '\n') return { key, value: null, line }
  if (char !== '=') throw src.fail(`expected "=" and a value after ${quote(key)}, found ${quote(char)}`)
  return { key, value: readValue(src), line }
}

// Each key in order: its section's name, lowercased, and subsection; the line
// of their header, undefined before any; and its own line. A UTF-8 byte
// order mark git skips at the start alone.
export function readConfig(text, where) {
  const src = cursor(text.startsWith('\uFEFF') ? text.slice(1) : text, where)
  const entries = []
  let header = { section: undefined, subsection: undefined, header: undefined }
  let comment = false
  for (;;) {
    const char = src.next()
    if (char === '\n') {
      if (src.eof) return entries
      comment = false
    } else if (comment || SPACE.has(char)) {
      continue
    } else if (char === '#' || char === ';') {
      comment = true
    } else if (char === '[') {
      const line = src.at
      const [section, subsection] = readHeader(src)
      header = { section, subsection, header: line }
    } else if (isAlpha(char)) {
      entries.push({ ...header, ...readEntry(src, char) })
    } else {
      throw src.fail(`${quote(char)}, where git reads a key, a section or a comment`)
    }
  }
}
