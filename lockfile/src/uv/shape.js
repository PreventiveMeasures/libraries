// What uv.lock's readers share: a URL and a timestamp as uv writes them,
// and tables and lists keyed or made of names in normal form.

import { LockfileError, quote } from '../error.js'
import { checkNormalName } from '../python/pep508.js'
import { isDateTime } from '../toml/datetime.js'
import { arrayOf, matching, string, tableOf } from '../toml/shape.js'

// A URL as the url crate writes it, as uv writes one: with no credentials,
// which uv strips, and of a scheme it fetches over.
export function checkUrl(value, where, schemes = ['https:', 'http:', 'file:']) {
  const url = URL.parse(string(value, where))
  if (url === null || url.href !== value || !schemes.includes(url.protocol)) {
    throw new LockfileError(`${quote(value)} is not a URL in normal form, of ${schemes.map((scheme) => scheme.slice(0, -1)).join(', ')}`, where)
  }
  if (url.username !== '' || url.password !== '') throw new LockfileError(`${quote(value)} has credentials in it, which uv does not write`, where)
  return url
}

// As jiff writes a timestamp: UTC, to the second or a fraction of it.
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u
export const checkTime = matching((time) => TIME.test(time) && isDateTime(time), 'a UTC timestamp')

export const names = arrayOf(checkNormalName)

// A table by name in normal form, each item as `read` makes it; empty where
// there is none.
export const byName = (value, where, read) => tableOf(value, where, read, checkNormalName)
