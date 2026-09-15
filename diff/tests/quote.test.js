import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quoteHeaderName } from '../src/quote.js'

// The names below are the ones GNU diff 3.10 was recorded against in the
// conformance corpus of @preventive/terminal, where they reached the header
// through the command line; here they reach the quoting directly, which is
// the only part of that path this package holds.

describe('a name is quoted only when it needs it', () => {
  for (const [name, quoted] of [
    ['a1', 'a1'],
    ['sp ace', '"sp ace"'],
    ['ta\tb', '"ta\\tb"'],
    ['quo"te', '"quo\\"te"'],
    ['back\\slash', '"back\\\\slash"'],
    // An apostrophe is nothing awkward to the C style, whatever a shell
    // would make of it.
    ["apos'", "apos'"],
    ['-dash', '-dash'],
  ]) {
    it(name, () => assert.equal(quoteHeaderName(name), quoted))
  }

  it('names every escape the C style has a letter for', () => {
    assert.equal(quoteHeaderName('\u0007\b\f\n\r\t\v'), '"\\a\\b\\f\\n\\r\\t\\v"')
  })

  it('escapes a control character that has no letter, by its octal byte', () => {
    assert.equal(quoteHeaderName('\u0001'), '"\\001"')
    assert.equal(quoteHeaderName('\u001B[0m'), '"\\033[0m"')
    assert.equal(quoteHeaderName('\u007F'), '"\\177"')
  })
})

describe('past ASCII, the locale decides', () => {
  // In a locale with characters, a printable one prints as itself; in a byte
  // locale there are no characters, so every byte of it is an octal escape.
  it('prints a printable character as itself', () => {
    assert.equal(quoteHeaderName('ünï'), 'ünï')
    assert.equal(quoteHeaderName('ünï', { byteLocale: false }), 'ünï')
  })

  it('escapes its bytes in the C locale', () => {
    assert.equal(quoteHeaderName('ünï', { byteLocale: true }), '"\\303\\274n\\303\\257"')
  })

  it('escapes what is not printable in either', () => {
    // A zero-width joiner is Cf — format, not a character to show.
    for (const byteLocale of [false, true]) assert.equal(quoteHeaderName('a‍b', { byteLocale }), '"a\\342\\200\\215b"')
  })

  it('escapes an unpaired surrogate as the replacement character it encodes to', () => {
    assert.equal(quoteHeaderName('\uD800'), '"\\357\\277\\275"')
  })
})
