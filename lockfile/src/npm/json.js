// package-lock.json exactly as npm writes it: JSON.stringify with the
// indentation and line ends npm takes from the project's package.json, and
// a line end after the last `}`. JSON.parse takes more, and reads a key
// given twice as the last, where other readers may take the first; a
// file it reads here is the one npm would write back.

import { LockfileError, quote } from '../error.js'
import { fail } from '../lines.js'

// parse-conflict-json, which npm reads the lockfile with, takes a file with
// all three of these anywhere in it, in a string too, as a merge conflict,
// and merges its sides into one.
const CONFLICT = ['<<<<<<<', '=======', '>>>>>>>']

// The line end after the opening brace and the indentation of the line
// after, as json-parse-even-better-errors finds them for npm to write the
// file again with.
const FORMAT = /^\{(\r?\n)([\t ]+)"/u

// Deeper than any lockfile npm writes, and shallow enough to walk.
const DEPTH = 16

// Objects as mappings with a null prototype, so a key is only ever a key.
function toRecords(value, depth) {
  if (typeof value !== 'object' || value === null) return value
  if (depth > DEPTH) throw new LockfileError(`nested more than ${DEPTH} deep, as npm writes nothing`)
  if (Array.isArray(value)) return value.map((item) => toRecords(item, depth + 1))
  const record = Object.create(null)
  for (const [key, item] of Object.entries(value)) record[key] = toRecords(item, depth + 1)
  return record
}

// The first line the text has otherwise than npm writes it.
function difference(text, written) {
  const lines = text.split('\n')
  const expected = written.split('\n')
  let line = 0
  while (lines[line] === expected[line]) line++
  if (line === expected.length - 1 && line === lines.length) return fail('expected a line end after the last "}"', line - 1)
  const found = line < lines.length ? quote(lines[line]) : 'the end of the file'
  return fail(`expected ${line < expected.length ? quote(expected[line]) : 'the end of the file'}, as npm writes it, found ${found}`, line)
}

export function readJson(text) {
  if (CONFLICT.every((marker) => text.includes(marker))) {
    throw new LockfileError(`npm reads a file with ${CONFLICT.map((marker) => quote(marker)).join(', ')} in it as a merge conflict`)
  }
  const format = FORMAT.exec(text)
  if (format === null) throw fail('expected "{" alone on the first line and an indented key on the next, as npm writes the file', 0)
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LockfileError(`not JSON: ${error.message}`)
  }
  const records = toRecords(value, 0)
  const [, eol, indent] = format
  const written = `${JSON.stringify(value, null, indent)}\n`.replaceAll('\n', eol)
  if (written !== text) throw difference(text, written)
  return records
}
