import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseToml } from '../../toml.js'
import { hasTomllib, plain, tomllib } from './reference.js'

// Python's tomllib, a TOML 1.0 reader, against this one, over documents
// put together at random from pieces, most of them TOML, many of them
// not: every document read here is read the same by tomllib; every one
// tomllib refuses is refused here; and one refused here that tomllib reads
// is refused for something named as not supported. The seed is fixed, so a
// failure names its document and comes back on a rerun.

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

// A linear congruential generator: enough to spread the pieces about.
function random(seed) {
  let state = seed
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  return { next, pick: (list) => list[Math.floor(next() * list.length)] }
}

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
    assert.equal(counts.unsupported, 0)
  })
})
