// An integer is a number within +/-(2^53 - 1) and a bigint past that, up to
// TOML's 64 bits, so none is rounded. A float is a TomlFloat, so that `1.0`
// is not the integer `1`; one that would be Infinity or 0 is refused.

import { assert, excerpt } from './error.js'

const DECIMAL = /^[+-]?(?:0|[1-9](?:_?\d)*)$/u
const RADIX = /^0(?:x[\dA-Fa-f](?:_?[\dA-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/u
const FLOAT = /^[+-]?(?:inf|nan|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*(?:[Ee][+-]?\d(?:_?\d)*)?|[Ee][+-]?\d(?:_?\d)*))$/u

const I64 = 2n ** 63n
const SAFE = BigInt(Number.MAX_SAFE_INTEGER)
// The digits of 2^63 - 1 in each base: more, past leading zeros, is out of
// range, and is not handed to BigInt, which is slow on a long string.
const DIGITS = { __proto__: null, x: 16, o: 21, b: 63 }

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

// undefined: not a float; null: a float a double cannot hold.
function floatOf(text) {
  if (typeof text !== 'string' || !FLOAT.test(text)) return undefined
  if (text in SPECIAL) return SPECIAL[text]
  const value = Number(text.replaceAll('_', ''))
  const zero = !/[1-9]/u.test(text.split(/[Ee]/u)[0])
  return Number.isFinite(value) && (value !== 0 || zero) ? value : null
}

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

export function readFloat(token, src) {
  const value = floatOf(token)
  if (value === undefined) return undefined
  assert(value !== null, src, () => `float out of range ${excerpt(token)}`)
  return new TomlFloat(token)
}
