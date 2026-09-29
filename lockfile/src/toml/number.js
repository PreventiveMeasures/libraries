// Integers and floats, none read as another number. An integer is decimal,
// or hexadecimal, octal or binary after `0x`, `0o` or `0b` (no sign, leading
// zeros allowed), with underscores between digits, and held to TOML's 64
// bits: a number within ±(2^53 − 1), and past that a bigint, which a double
// would round. A float is a binary64 double in a TomlFloat, with the text it
// was written as, so that `1.0` is not the integer `1`; one a double cannot
// hold, which would be Infinity or 0 where the text is neither, is refused.

import { assert, excerpt } from './error.js'

const DECIMAL = /^[+-]?(?:0|[1-9](?:_?\d)*)$/u
const RADIX = /^0(?:x[\dA-Fa-f](?:_?[\dA-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/u
const FLOAT = /^[+-]?(?:inf|nan|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*(?:[Ee][+-]?\d(?:_?\d)*)?|[Ee][+-]?\d(?:_?\d)*))$/u

const I64 = 2n ** 63n
const SAFE = BigInt(Number.MAX_SAFE_INTEGER)
// The most digits 2^63 − 1 has, in each base: more, past leading zeros, is
// out of range however it goes on, and is not handed to BigInt, which is
// slow to read a long one.
const DIGITS = { __proto__: null, x: 16, o: 21, b: 63 }

// An integer, or undefined where the token is not one.
export function readInteger(token, src) {
  const decimal = DECIMAL.test(token)
  if (!decimal && !RADIX.test(token)) return undefined
  const digits = token.replaceAll('_', '')
  const significant = decimal ? digits.replace(/^[+-]/u, '') : digits.slice(2).replace(/^0+/u, '')
  const fits = significant.length <= (decimal ? 19 : DIGITS[digits[1]])
  const value = fits ? BigInt(decimal ? digits : `${digits.slice(0, 2)}${significant || '0'}`) : undefined
  assert(value !== undefined && value >= -I64 && value < I64, src, () => `integer out of range ${excerpt(token)}`)
  return value >= -SAFE && value <= SAFE ? Number(value) : value
}

const SPECIAL = { __proto__: null, inf: Infinity, '+inf': Infinity, '-inf': -Infinity, nan: Number.NaN, '+nan': Number.NaN, '-nan': Number.NaN }

// The double a float's text names; undefined where the text is not a
// float, null where a double cannot hold it.
function floatOf(text) {
  if (typeof text !== 'string' || !FLOAT.test(text)) return undefined
  if (text in SPECIAL) return SPECIAL[text]
  const value = Number(text.replaceAll('_', ''))
  const zero = !/[1-9]/u.test(text.split(/[Ee]/u)[0])
  return Number.isFinite(value) && (value !== 0 || zero) ? value : null
}

// A float as written: `text` is its spelling, underscores and all, `value`
// the double it names, which valueOf() and toJSON() give. Frozen; the
// constructor takes only what the parser would read, else a TypeError.
export class TomlFloat {
  constructor(text) {
    const value = floatOf(text)
    if (value === undefined || value === null) throw new TypeError('expected a TOML float that a double can hold')
    this.text = text
    this.value = value
    Object.freeze(this)
  }

  valueOf() {
    return this.value
  }

  toString() {
    return this.text
  }

  toJSON() {
    return this.value
  }
}

// A float, or undefined where the token is not one.
export function readFloat(token, src) {
  const value = floatOf(token)
  if (value === undefined) return undefined
  assert(value !== null, src, () => `float out of range ${excerpt(token)}`)
  return new TomlFloat(token)
}
