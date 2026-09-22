import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError } from '../src/error.js'
import { checkString, decodeUtf8, encodeUtf8, hasUnsafe, quote, utf8Length } from '../src/text.js'

// The text helpers are where a string that is not well-formed, or bytes
// that are not UTF-8, are stopped: nothing past them sees either.

describe('checkString', () => {
  it('takes any well-formed string', () => {
    for (const text of ['', 'a', 'ü/日本', '😀', '👨‍👩‍👧']) checkString(text, 'name')
  })
  it('refuses what is not a string, naming what it was checking', () => {
    for (const value of [undefined, null, 42, Symbol('s'), ['a'], { toString: () => 'a' }]) {
      assert.throws(() => checkString(value, 'the name'), (error) => error instanceof ArchiveError && error.message === 'the name is not a string')
    }
  })
  it('refuses a lone surrogate wherever it sits', () => {
    for (const text of ['\uD800', 'a\uD83D', '\uDC00b', 'a\uDBFFb', '\uD83D😀']) {
      assert.throws(() => checkString(text, 'the name'), /the name is not well-formed Unicode/u)
    }
  })
})

describe('quote', () => {
  it('escapes what a terminal would act on', () => {
    assert.equal(quote('a\u001B[31mb\n'), String.raw`"a\u001b[31mb\n"`)
    assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"')
  })
  it('cuts a long name, and never through a surrogate pair', () => {
    assert.equal(quote('x'.repeat(200)), `"${'x'.repeat(200)}"`)
    assert.equal(quote('x'.repeat(201)), `"${'x'.repeat(200)}…"`)
    const pairAt199 = `${'x'.repeat(199)}😀y`
    assert.equal(quote(pairAt199), `"${'x'.repeat(199)}…"`)
    assert.ok(quote(pairAt199).isWellFormed())
    assert.equal(quote(`${'x'.repeat(198)}😀y`), `"${'x'.repeat(198)}😀…"`)
  })
  it('still escapes a lone surrogate handed to it', () => {
    assert.equal(quote('a\uD800'), String.raw`"a\ud800"`)
  })
})

describe('hasUnsafe', () => {
  it('flags C0, DEL and C1 controls, line separators and bidi controls', () => {
    for (const char of ['\u0000', '\n', '\u001F', '\u007F', '\u0080', '\u009F', ' ', ' ', '‪', '‮', '⁦', '⁩']) {
      assert.equal(hasUnsafe(`a${char}b`, false), true, JSON.stringify(char))
    }
  })
  it('flags a backslash only when asked', () => {
    assert.equal(hasUnsafe('a\\b', true), true)
    assert.equal(hasUnsafe('a\\b', false), false)
  })
  it('lets ordinary text through, joiners and marks included', () => {
    for (const text of ['', 'a b', 'ü/日本', 'tab nbsp', '👨‍👩‍👧', 'é', '‧', '⁥', '⁪']) {
      assert.equal(hasUnsafe(text, true), false, JSON.stringify(text))
    }
  })
})

describe('utf8Length', () => {
  it('counts the bytes each code point takes', () => {
    assert.equal(utf8Length(''), 0)
    assert.equal(utf8Length('a'), 1)
    assert.equal(utf8Length('ü'), 2)
    assert.equal(utf8Length('日'), 3)
    assert.equal(utf8Length('😀'), 4)
    assert.equal(utf8Length('aü日😀'), 10)
  })
})

describe('encodeUtf8 and decodeUtf8', () => {
  it('round-trip well-formed text', () => {
    for (const text of ['', 'a', 'ü/日本', '😀', 'a\u0000b']) assert.equal(decodeUtf8(encodeUtf8(text, 'text'), 'text'), text)
  })
  it('refuse a lone surrogate, naming the field', () => {
    assert.throws(() => encodeUtf8('a\uD800', 'uname'), /uname is not well-formed Unicode/u)
  })
  it('refuse bytes that are not UTF-8: a surrogate, an overlong form, a cut sequence, a stray continuation', () => {
    const bad = [[0xed, 0xa0, 0x80], [0xc0, 0xaf], [0xe2, 0x82], [0x80], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80]]
    for (const bytes of bad) {
      assert.throws(() => decodeUtf8(Uint8Array.from(bytes), 'entry name', 7), (error) => error instanceof ArchiveError && error.message === 'entry name is not valid UTF-8 at byte 7' && error.offset === 7)
    }
  })
  it('hand back only well-formed strings', () => {
    assert.ok(decodeUtf8(Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]), 'text').isWellFormed())
  })
})
