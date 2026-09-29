// Reads toml-test, the TOML test suite (github.com/toml-lang/toml-test,
// MIT), at a fixed commit: every file of its TOML 1.0 list. An invalid
// document has to be refused, as not UTF-8 by a strict decoder or by
// parseToml; a valid one read as its .json says, or refused by name as not
// supported. Needs git, with network access to GitHub, or a checkout of
// toml-test named instead:
//
//     node lockfile/scripts/toml-test.js [checkout]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { TomlDateTime, parseToml } from '../toml.js'

const COMMIT = 'ff49d109861c1ad25af53f687f2aef19ab650600'
const UNSUPPORTED = /not supported|out of range|a byte order mark/u

function fetchSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'toml-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  git('init', '-q')
  git('fetch', '-q', '--depth', '1', 'https://github.com/toml-lang/toml-test', COMMIT)
  git('checkout', '-q', 'FETCH_HEAD')
  return dir
}

// toml-test writes a date-time its own way, so one is held to the instant
// it names, to the microsecond.
function instant(text) {
  const m = /^(.{19})(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/iu.exec(text.replace(' ', 'T'))
  const date = new TomlDateTime(`${m[1].toUpperCase()}${m[3].toUpperCase()}`).toDate()
  return `${date.getTime()}.${(m[2] ?? '').padEnd(6, '0').slice(0, 6)}`
}

// A parsed document as toml-test's JSON has it, each value tagged.
function tagged(value) {
  if (value instanceof TomlDateTime) return { type: 'datetime', value: instant(value.text) }
  if (Array.isArray(value)) return value.map(tagged)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tagged(item)]))
  if (typeof value === 'string') return { type: 'string', value }
  return { type: typeof value === 'boolean' ? 'bool' : 'integer', value: String(value) }
}

function expected(value) {
  if (Array.isArray(value)) return value.map(expected)
  const tag = Object.keys(value).length === 2 && typeof value.type === 'string' && typeof value.value === 'string'
  if (tag) return value.type === 'datetime' ? { type: 'datetime', value: instant(value.value) } : value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expected(item)]))
}

const dir = process.argv[2] ?? fetchSuite()
const tests = join(dir, 'tests')
const files = readFileSync(join(tests, 'files-toml-1.0.0'), 'utf8').split('\n').filter((file) => file.endsWith('.toml'))
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const counts = { refused: 0, notUtf8: 0, read: 0, unsupported: 0 }
const problems = []
for (const file of files) {
  const invalid = file.startsWith('invalid/')
  let text
  try {
    text = decoder.decode(readFileSync(join(tests, file)))
  } catch {
    if (invalid) counts.notUtf8++
    else problems.push(`${file}: valid, and not UTF-8`)
    continue
  }
  let doc
  try {
    doc = parseToml(text)
  } catch (error) {
    if (invalid) counts.refused++
    else if (UNSUPPORTED.test(error.message)) counts.unsupported++
    else problems.push(`${file}: valid, and refused as ${error.message}`)
    continue
  }
  if (invalid) problems.push(`${file}: invalid, and read as ${JSON.stringify(doc)}`)
  else if (isDeepStrictEqual(tagged(doc), expected(JSON.parse(readFileSync(join(tests, file.replace(/\.toml$/u, '.json')), 'utf8'))))) counts.read++
  else problems.push(`${file}: read otherwise than its .json says`)
}
if (process.argv[2] === undefined) rmSync(dir, { recursive: true })
console.log(`${files.length} files: ${counts.refused} invalid refused, ${counts.notUtf8} invalid not UTF-8, ${counts.read} valid read, ${counts.unsupported} valid refused as not supported`)
for (const problem of problems) console.log(problem)
process.exitCode = problems.length > 0 ? 1 : 0
