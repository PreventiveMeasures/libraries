// Offset date-times, the one kind of TOML date or time read here, as pylock
// files carry an upload time: RFC 3339 as writers emit it, a `T` between
// date and time and `Z` or an offset after. The space TOML allows for `T`,
// a lower-case `t` or `z`, and the local date-times, dates and times, which
// name no instant, are refused. A date that is not in the calendar is
// refused too (February 30th, second 60, year 0), where Date would roll it
// over into another.

import { TomlError, assert, excerpt } from './error.js'

const DATETIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/u
const LOCAL = /^(?:\d{4}-\d\d-\d\d(?:[Tt]\d\d:\d\d:\d\d(?:\.\d+)?)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/u
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function partsOf(text) {
  const m = DATETIME.exec(text)
  if (m === null) return undefined
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (month === 2 && leap ? 29 : DAYS[month - 1])) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  if (m[8] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return undefined
  const offset = m[8] === undefined ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]))
  return { year, month, day, hour, minute, second, fraction: m[7]?.slice(1) ?? '', offset }
}

// An offset date-time, kept as written: `text` is its RFC 3339 spelling,
// fractional seconds to however many digits it has, and the offset it was
// written in. toDate() is the instant, to the millisecond.
export class TomlDateTime {
  constructor(text) {
    if (typeof text !== 'string' || partsOf(text) === undefined) throw new TypeError('expected an RFC 3339 offset date-time')
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }

  toJSON() {
    return this.text
  }

  toDate() {
    const { year, month, day, hour, minute, second, fraction, offset } = partsOf(this.text)
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)))
    return new Date(date.getTime() - offset * 60_000)
  }
}

// A token that begins as a date or a time is one, or is refused; anything
// else is not a date-time, and undefined.
export function readDateTime(token, src) {
  if (!/^(?:\d{4}-\d\d-\d\d|\d\d:\d\d)/u.test(token)) return undefined
  if (partsOf(token) !== undefined) return new TomlDateTime(token)
  const spaced = /^\d{4}-\d\d-\d\d$/u.test(token) && /^ \d\d:/u.test(src.text.slice(src.pos, src.pos + 4))
  assert(!spaced, src, 'a date-time with a space in place of "T" is not supported')
  assert(!LOCAL.test(token), src, () => `local dates and times are not supported: ${excerpt(token)}`)
  assert(partsOf(token.toUpperCase()) === undefined, src, () => `a date-time with a lower-case "t" or "z" is not supported: ${excerpt(token)}`)
  throw new TomlError(`${excerpt(token)} is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`, src.line)
}
