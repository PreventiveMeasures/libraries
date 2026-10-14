import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { expectObject, extractJSON, oneLine, stringList } from '../src/json.js'

describe('extractJSON', () => {
  it('parses bare JSON', () => {
    assert.deepEqual(extractJSON('{"a":1}'), { a: 1 })
    assert.deepEqual(extractJSON('[1,2]'), [1, 2])
  })

  it('reads JSON out of a code fence, with prose around it', () => {
    assert.deepEqual(extractJSON('Here you go:\n```json\n{"picks":[{"n":1,"score":9}]}\n```\nDone.'), { picks: [{ n: 1, score: 9 }] })
    assert.deepEqual(extractJSON('```\n[1]\n```'), [1])
  })

  it('prefers the object when a bracketed aside precedes it', () => {
    assert.deepEqual(extractJSON('The picks [see below]: {"picks":[]}'), { picks: [] })
  })

  it('takes the outermost object, nested brackets and all', () => {
    assert.deepEqual(extractJSON('x {"a":{"b":[1,{"c":2}]}} y'), { a: { b: [1, { c: 2 }] } })
  })

  it('throws on text with no JSON, or with JSON that does not parse', () => {
    assert.throws(() => extractJSON('no json here'), /no JSON/u)
    assert.throws(() => extractJSON('{"a":'), /no JSON/u)
    assert.throws(() => extractJSON(null), TypeError)
  })
})

describe('shape helpers', () => {
  it('expectObject refuses arrays, primitives and null', () => {
    assert.deepEqual(expectObject({ a: 1 }, 'a'), { a: 1 })
    for (const bad of [[], null, 'x', 4]) assert.throws(() => expectObject(bad, 'a'), /expected a JSON object with a/u)
  })

  it('stringList keeps trimmed non-empty strings and drops the rest', () => {
    assert.deepEqual(stringList([' a ', '', 3, null, 'b']), ['a', 'b'])
    assert.deepEqual(stringList('a'), [])
  })

  it('oneLine folds newlines into single spaces', () => {
    assert.equal(oneLine('a\n  b\n\nc '), 'a b c')
    assert.equal(oneLine(undefined), '')
  })
})
