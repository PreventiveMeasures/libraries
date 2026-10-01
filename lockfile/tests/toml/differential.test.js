import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseToml } from '../../toml.js'
import { hasTomllib, plain, tomllib } from './reference.js'
import { random } from '../random.js'

// Python's tomllib, a TOML 1.0 reader, against this one, over documents
// made at random: from pieces, from TOML's grammar, from the fixtures with
// edits, and from characters in any order. Every document read here is read
// the same by tomllib; every one tomllib refuses is refused here; and one
// refused here that tomllib reads is refused for something named as not
// supported. The seeds are fixed, so a failure names its document and comes
// back on a rerun.

const HEADERS = ['[a]', '[a.b]', '[ a . b ]', '[[a]]', '[[a.b]]', '["q k"]', "['lit']", '[a."b.c"]', '[b]', '[a.b.c]', '[[b.c]]', '[a.x]', '[x.y]', '[x]', '[]', '[a', '[[a]', '[ [a] ]', '[a.]', '[[ a ]]', '[a . "b"]', '[\ta]']
const KEYS = ['x', 'y', '"q"', "'l'", 'a', 'b', 'a.b', 'b.c', 'x.y', 'x.y.z', '"a".b', 'a . b', '1', '-', '_', '""', 'bad key', 'k#', 'c', 'a.x', 'y.z']
const GOOD = ['1', '-0', '1_000', 'true', '"s"', "'l'", '[1, 2]', '[\n1,\n]', '{}', '{ a = 1 }', '{ a.b = 1, a.c = 2 }', '[{ a = 1 }]', '1979-05-27T07:32:00Z', '{ x = { y = 1 } }']
const VALUES = [
  '1', '-0', '+5', '1_000', '1__0', '_1', '01', '9007199254740991', '9007199254740992', 'true', 'false', 'True',
  '"s"', '"a\\tb"', '"\\u00e9"', '"\\ud800"', '"\\x41"', '"\\e"', '"\\q"', "'lit\\'", "'''x'''", '"""x"""', '"unterminated',
  '1.5', 'inf', '-nan', '0x1f', '0o7', '1e3',
  '1979-05-27T07:32:00Z', '1979-05-27T07:32:00.123456+05:30', '1979-05-27T07:32:00-00:00', '1979-05-27', '07:32:00',
  '1979-05-27 07:32:00Z', '1979-05-27t07:32:00z', '2023-02-29T00:00:00Z', '2024-02-29T23:59:59Z', '0000-01-01T00:00:00Z',
  '1979-05-27T24:00:00Z', '1979-05-27T07:32:60Z', '1979-05-27T07:32:00+24:00',
  '[]', '[1, 2]', '[1,]', '[,]', '[1 2]', '[\n1,\n# c\n2,\n]', '[\n]', '[[1], [2, [3]]]', '{}', '{ a = 1 }', '{ a = 1, }',
  '{ a.b = 1, a.c = 2 }', '{ a = {b = 1}, a.c = 2 }', '{ a = 1, a = 2 }', '[{ a = 1 }, { b = 2 }]', '{ a = [1] }', '{ a = 1\n}',
  '{ b = [\n1,\n] }', '{ b = [\n1 ]\n}', '[ { b = 1 },\n{ c = [\n2 ] } ]',
  '"c1\u0085"', "'del\u007F'", 'x', '', '"é "', "'tab\tok'", '"ctl\u0001"', '{"q" = 1, \'l\' = 2}', '[ "a", \'b\' ]',
]
const TRAIL = [' # c', '\t#c', ' #\u0001', ' #\u0085', ' #\u007F', ' x', '  ']
const ENDS = ['\n', '\r\n', '\r']

const TABLE_HEADERS = ['[a]', '[a.b]', '[[a]]', '[[a.b]]', '[b]', '[a.b.c]', '[[b.c]]', '[a.x]', '[x.y]', '[x]', '[x.y.z]', '[[x.y]]', '[b.c]', '[b.c.d]', '[a.b.d]', '["a".b]']
const TABLE_KEYS = ['x', 'y', 'a', 'b', 'c', 'a.b', 'b.c', 'x.y', 'x.y.z', 'a.x', 'y.z', 'c.d', 'b.c.d', 'z']

// Documents of anything: every piece, a line end of every kind, junk after.
function anything({ next, pick }) {
  let text = next() < 0.02 ? '﻿' : ''
  const count = 1 + Math.floor(next() * 8)
  for (let i = 0; i < count; i++) {
    const r = next()
    const value = next() < 0.7 ? pick(GOOD) : pick(VALUES)
    const line = r < 0.25 ? pick(HEADERS) : r < 0.85 ? `${pick(KEYS)}${pick([' = ', ' = ', '=', ' =\t', ' '])}${value}` : r < 0.93 ? '# comment' : ''
    text += `${pick(['', '', ' ', '\t'])}${line}${next() < 0.8 ? '' : pick(TRAIL)}${i === count - 1 && next() < 0.3 ? '' : next() < 0.9 ? '\n' : pick(ENDS)}`
  }
  return text
}

// Documents of headers and keys alone, for the rules of who writes a table.
function tables({ next, pick }) {
  const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => (next() < 0.35 ? pick(TABLE_HEADERS) : `${pick(TABLE_KEYS)} = ${pick(GOOD)}`))
  return `${lines.join('\n')}\n`
}

// Valid TOML from its grammar, with every kind of value this reader takes,
// multi-line strings, floats and integers of every base and size among
// them, and a few it refuses as unsupported; half of the documents then
// have one character put in or taken out, so that each check is met on its
// own.
const STRING_CHARS = ['a', 'Z', ' ', '\t', '#', '=', '.', "'", '"', '\\', '[', '{', ',', '}', 'é', '😀', '\u0085', '\u009F', '\u00A0', '\u2028', '\u200F', '\uFFFF']
const ESCAPES = ['\\n', '\\t', '\\b', '\\f', '\\r', '\\"', '\\\\', '\\u00e9', '\\u0000', '\\u007F', '\\uFFFF', '\\U0001F600', '\\U0010FFFF']
const BARE_KEYS = ['a', 'b', 'c', 'x', 'y', 'k1', '_', '-', '1', 'A-b_2', 'true', 'inf', '0', '00', '1979-05-27']
const UNSUPPORTED_VALUES = ['1979-05-27', '07:32:00', '1979-05-27T07:32:00', '1979-05-27 07:32:00Z', '1e400', '9223372036854775808', '0x8000000000000000']
const MULTILINE_PIECES = ['a', ' ', '\t', '#', 'é', '😀', '\u0085', '\u2028', '\n', '\n', '\r\n', '"', '""', "'", "''", '\\', '{', '=']
const LINE_ENDS = ['\\\n', '\\  \n  ', '\\\r\n\n\t', '\\\t\n']
const FLAWS = ['[', ']', '{', '}', '=', ',', '.', '"', "'", '#', '\\', '\n', '\r', ' ', '\t', 'a', '0', '_', '-', '+', ':', 'T', 'Z', 'z', 'e', '\u0000', '\u007F', '\u0085', '\uFEFF']

function grammar({ next, pick }) {
  const int = (n) => Math.floor(next() * n)
  const some = (n, make) => Array.from({ length: int(n) }, make)
  const space = () => pick(['', ' ', ' ', '\t', '  '])
  const basic = () => `"${some(5, () => (next() < 0.3 ? pick(ESCAPES) : pick(STRING_CHARS).replace(/^["\\]$/u, '\\$&'))).join('')}"`
  const literal = () => `'${some(5, () => pick(STRING_CHARS).replace(/^'$/u, '"')).join('')}'`
  const key = () => Array.from({ length: next() < 0.7 ? 1 : 2 + int(2) }, () => (next() < 0.75 ? pick(BARE_KEYS) : next() < 0.6 ? basic() : literal())).join(pick(['.', ' . ', '\t.']))
  const two = (n) => String(n).padStart(2, '0')
  function datetime() {
    const year = 1 + int(9999)
    const month = 1 + int(12)
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    const fraction = next() < 0.3 ? `.${some(10, () => int(10)).join('')}0` : ''
    const offset = pick(['Z', '+00:00', '-00:00', `+${two(int(24))}:${two(int(60))}`, `-${two(int(24))}:${two(int(60))}`])
    return `${String(year).padStart(4, '0')}-${two(month)}-${two(next() < 0.2 ? days : 1 + int(days))}T${two(int(24))}:${two(int(60))}:${two(int(60))}${fraction}${offset}`
  }
  const digits = (alphabet, count) => Array.from({ length: count }, () => alphabet[int(alphabet.length)]).join('')
  const grouped = (text) => (next() < 0.3 ? text.replace(/.(?=.)/gu, (digit) => (next() < 0.3 ? `${digit}_` : digit)) : text)
  const sign = () => pick(['', '', '-', '+'])
  function integer() {
    const r = next()
    if (r < 0.2) {
      const [prefix, alphabet] = pick([['0x', '0123456789abcdefABCDEF'], ['0o', '01234567'], ['0b', '01']])
      return `${prefix}${grouped(digits(alphabet, 1 + int(prefix === '0b' ? 64 : 17)))}`
    }
    if (r < 0.3) return `${sign()}${grouped(`${1 + int(9)}${digits('0123456789', 15 + int(4))}`)}`
    if (r < 0.35) return `${sign()}${pick(['0', '9007199254740991', '9_007_199_254_740_991', '9223372036854775807'])}`
    return `${sign()}${grouped(`${1 + int(9)}${digits('0123456789', int(13))}`)}`
  }
  function float() {
    if (next() < 0.15) return `${sign()}${pick(['inf', 'nan'])}`
    const whole = next() < 0.2 ? '0' : grouped(`${1 + int(9)}${digits('0123456789', int(12))}`)
    const fraction = next() < 0.7 ? `.${grouped(digits('0123456789', 1 + int(20)))}` : ''
    const exponent = fraction === '' || next() < 0.4 ? `${pick(['e', 'E'])}${pick(['', '+', '-'])}${grouped(digits('0123456789', 1 + int(next() < 0.9 ? 2 : 3)))}` : ''
    return `${sign()}${whole}${fraction}${exponent}`
  }
  // Pieces that make three quotes in a row only where the string ends.
  function multiline() {
    const quote = pick(['"', "'"])
    const pieces = some(12, () => {
      const piece = pick(MULTILINE_PIECES)
      if (quote === "'") return piece
      return piece === '\\' ? pick(LINE_ENDS) : next() < 0.2 ? pick(ESCAPES) : piece
    })
    const body = pieces.join('').replace(quote === '"' ? /"{3,}/gu : /'{3,}/gu, quote.repeat(2))
    return `${quote.repeat(3)}${pick(['', '\n', '\r\n'])}${body}${quote.repeat(3)}`
  }
  function value(depth) {
    const r = next()
    if (r < 0.12) return basic()
    if (r < 0.18) return literal()
    if (r < 0.28) return multiline()
    if (r < 0.42) return integer()
    if (r < 0.5) return float()
    if (r < 0.54) return pick(['true', 'false'])
    if (r < 0.62) return datetime()
    if (r < 0.64) return pick(UNSUPPORTED_VALUES)
    if (depth > 3) return integer()
    const items = some(4, () => value(depth + 1))
    if (r < 0.8) return `[${space()}${pick(['', '\n'])}${items.join(pick([', ', ',', ' , ', ',\n', ', # c\n', ',\r\n']))}${items.length > 0 ? pick(['', ',']) : ''}${pick(['', '\n'])}${space()}]`
    return `{${space()}${items.map((item) => `${key()}${space()}=${space()}${item}`).join(pick([', ', ',', ' , ']))}${space()}}`
  }
  const lines = Array.from({ length: 1 + int(8) }, () => {
    const r = next()
    const line = r < 0.2 ? (next() < 0.3 ? `[[${space()}${key()}${space()}]]` : `[${space()}${key()}${space()}]`)
      : r < 0.9 ? `${key()}${space()}=${space()}${value(0)}`
      : `#${some(4, () => pick(STRING_CHARS)).join('')}`
    return `${pick(['', '', '', ' ', '\t'])}${line}${next() < 0.15 ? `${space()}#${pick(STRING_CHARS)}` : ''}`
  })
  const text = `${lines.join(next() < 0.8 ? '\n' : '\r\n')}${pick(['\n', '', '\r\n'])}`
  return next() < 0.5 ? text : edit(text, next() < 0.5 ? 1 : 0, pick(FLAWS), next)
}

// A text with `count` characters taken out at a place picked at random, and
// `insert` put in there: whole code points, as a text that is not UTF-8
// cannot be TOML.
function edit(text, count, insert, next) {
  const chars = [...text]
  chars.splice(Math.floor(next() * (chars.length + 1)), count, insert)
  return chars.join('')
}

// Runs of lines from the fixtures, real TOML as tools write it, each with a
// few edits: characters taken out or put in, a line repeated or moved.
const FIXTURES = new URL('fixtures/', import.meta.url)
const REAL = readdirSync(FIXTURES).filter((name) => !name.endsWith('.json')).map((name) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n'))
const INSERTS = [...FLAWS, '[[', ']]', '""', 'x.y', '[a]', 'a = 1\n']

function edited({ next, pick }) {
  const int = (n) => Math.floor(next() * n)
  const file = pick(REAL)
  const start = int(Math.max(1, file.length - 30))
  let lines = file.slice(start, start + 5 + int(40))
  for (let edits = 1 + int(3); edits > 0; edits--) {
    const r = next()
    if (r < 0.6) {
      lines = edit(lines.join('\n'), r < 0.3 ? 1 + int(3) : 0, r < 0.3 ? '' : pick(INSERTS), next).split('\n')
    } else if (r < 0.8) {
      lines.splice(int(lines.length + 1), 0, pick(lines))
    } else {
      const [i, j] = [int(lines.length), int(lines.length)];
      [lines[i], lines[j]] = [lines[j], lines[i]]
    }
  }
  return lines.join('\n')
}

// Characters and short runs TOML is made of, in any order at all.
const ALPHABET = ['a', 'b', '1', '0', '9', '_', '-', '+', '.', ':', 'T', 'Z', 'e', 'x', 'n', 'f', 't', 'r', 'u', ' ', '\t', '\n', '\r', '\r\n', '=', '[', ']', '{', '}', ',', '"', "'", '#', '\\', 'U', '\u0000', '\u007F', '\u0085', '\u00A0', 'é', '😀', '\uFEFF', '\f', '\u2028', '2024-01-01', '00:00:00', '"""', "'''"]
const characters = ({ next, pick }) => Array.from({ length: 1 + Math.floor(next() * 24) }, () => pick(ALPHABET)).join('')

const UNSUPPORTED = /not supported|out of range|a byte order mark/u

function compare(texts) {
  const references = tomllib(texts)
  const counts = { both: 0, neither: 0, unsupported: 0 }
  for (const [index, text] of texts.entries()) {
    const reference = references[index]
    let value
    try {
      value = plain(parseToml(text))
    } catch (error) {
      assert.equal(error.name, 'TomlError', `${JSON.stringify(text)}: ${error.stack}`)
      if (reference.error === undefined) {
        assert.match(error.message, UNSUPPORTED, `${JSON.stringify(text)} is TOML tomllib reads, refused as ${error.message}`)
        counts.unsupported++
      } else {
        counts.neither++
      }
      continue
    }
    assert.equal(reference.error, undefined, `${JSON.stringify(text)} is read here, and refused by tomllib: ${reference.error}`)
    assert.deepEqual(value, reference.value, JSON.stringify(text))
    counts.both++
  }
  return counts
}

describe('against tomllib', { skip: !hasTomllib() && 'no python3 with tomllib' }, () => {
  it('documents of anything', () => {
    const generator = random(0x70_4D_4C)
    const counts = compare(Array.from({ length: 6000 }, () => anything(generator)))
    assert.ok(counts.both > 800 && counts.neither > 3000 && counts.unsupported > 10, JSON.stringify(counts))
  })

  it('documents of tables, dotted keys and arrays of tables', () => {
    const generator = random(0x7A_B1_E5)
    const counts = compare(Array.from({ length: 6000 }, () => tables(generator)))
    assert.ok(counts.both > 1000 && counts.neither > 3000, JSON.stringify(counts))
  })

  it('valid documents from the grammar, half of them with one flaw', () => {
    const generator = random(0x6A_7A_11)
    const counts = compare(Array.from({ length: 6000 }, () => grammar(generator)))
    assert.ok(counts.both > 2000 && counts.neither > 2000 && counts.unsupported > 200, JSON.stringify(counts))
  })

  it('runs of lines from the fixtures, edited', () => {
    const generator = random(0x3D_17_ED)
    const counts = compare(Array.from({ length: 3000 }, () => edited(generator)))
    assert.ok(counts.both > 500 && counts.neither > 1500, JSON.stringify(counts))
  })

  it('characters in any order', () => {
    const generator = random(0x0C_4A_25)
    const counts = compare(Array.from({ length: 6000 }, () => characters(generator)))
    assert.ok(counts.both > 40 && counts.neither > 5000, JSON.stringify(counts))
  })
})
