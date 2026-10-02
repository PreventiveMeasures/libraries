// Only offset date-times are read: local ones name no instant. RFC 3339's
// year 0000 and leap second are refused: Date and tomllib cannot hold them,
// and the toml crate rolls a leap second over. A date not in the calendar is
// refused, where Date would roll it over too.

import { TomlError, assert, excerpt } from './error.js'

const DATETIME = /^(\d{4})-(\d\d)-(\d\d)([Tt])(\d\d):(\d\d):(\d\d)(\.\d+)?(?:([Zz])|([+-])(\d\d):(\d\d))$/u
const LOCAL = /^(?:\d{4}-\d\d-\d\d(?:[Tt]\d\d:\d\d:\d\d(?:\.\d+)?)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/u
const NO_SECONDS = /^(?:\d{4}-\d\d-\d\d[Tt])?\d\d:\d\d(?:[Zz]|[+-]\d\d:\d\d)?$/u
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// undefined where not RFC 3339; `unsupported` lists why one is not read.
function partsOf(text) {
  const m = DATETIME.exec(text)
  if (m === null) return undefined
  const [year, month, day, hour, minute, second] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5]), Number(m[6]), Number(m[7])]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  if (month < 1 || month > 12 || day < 1 || day > (month === 2 && leap ? 29 : DAYS[month - 1])) return undefined
  if (hour > 23 || minute > 59 || second > 60) return undefined
  if (m[10] !== undefined && (Number(m[11]) > 23 || Number(m[12]) > 59)) return undefined
  const unsupported = []
  if (m[4] === 't' || m[9] === 'z') unsupported.push('a date-time with a lower-case "t" or "z" is not supported')
  if (year === 0) unsupported.push('the year 0000 is not supported')
  if (second === 60) unsupported.push('a leap second is not supported')
  const offset = m[10] === undefined ? 0 : (m[10] === '-' ? -1 : 1) * (Number(m[11]) * 60 + Number(m[12]))
  return { year, month, day, hour, minute, second, fraction: m[8]?.slice(1) ?? '', offset, unsupported }
}

export class TomlDateTime {
  constructor(text) {
    if (typeof text !== 'string' || partsOf(text)?.unsupported.length !== 0) throw new TypeError('expected an RFC 3339 offset date-time')
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }

  toJSON() {
    return this.text
  }

  // Minutes past the hour roll over, the offset's among them.
  toDate() {
    const { year, month, day, hour, minute, second, fraction, offset } = partsOf(this.text)
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute - offset, second, Number(fraction.padEnd(3, '0').slice(0, 3)))
    return date
  }
}

// Whether `text` is a date-time the parser reads, its date in the calendar.
export const isDateTime = (text) => partsOf(text)?.unsupported.length === 0

// Of the reasons a date-time is not read, one alone is named.
export function readDateTime(token, src) {
  if (!/^(?:\d{4}-\d\d-\d\d|\d\d:\d\d)/u.test(token)) return undefined
  const parts = partsOf(token)
  if (parts?.unsupported.length === 0) return new TomlDateTime(token)
  const spaced = /^\d{4}-\d\d-\d\d$/u.test(token) && /^ \d\d:/u.test(src.text.slice(src.pos, src.pos + 4))
  assert(!spaced, src, 'a date-time with a space in place of "T" is not supported')
  assert(!LOCAL.test(token), src, () => `local dates and times are not supported: ${excerpt(token)}`)
  assert(!NO_SECONDS.test(token), src, () => `a date-time or a time without seconds is not supported: ${excerpt(token)}`)
  assert(parts?.unsupported.length !== 1, src, () => `${parts.unsupported[0]}: ${excerpt(token)}`)
  throw new TomlError(`${excerpt(token)} is not a date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`, src.line)
}
