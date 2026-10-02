// soldeer.lock as Soldeer 0.4 to 0.12 write it: a format version, from 0.12,
// and a table for each dependency, as toml_edit lays them out.

import { LockfileError, at, quote } from '../error.js'
import { isCommit, isHexSha256, isHttpUrl } from '../names.js'
import { compareCodePoints } from '../order.js'
import { checkOptions, string } from '../shape.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { checkConfig, claimFolder } from './config.js'

// In the order Soldeer writes them; a dependency's kind is what it has.
const FIELDS = ['name', 'version', 'git', 'url', 'rev', 'checksum', 'integrity']
const KINDS = {
  http: ['name', 'version', 'url', 'checksum', 'integrity'],
  git: ['name', 'version', 'git', 'rev'],
  private: ['name', 'version', 'checksum', 'integrity'],
}
const HAVING = { http: 'a url', git: 'a git repository', private: 'neither a url nor a git repository' }

// Soldeer writes a custom URL as the config has it, its scheme in any case.
const isUrl = (value) => isHttpUrl(value.replace(/^https?:/iu, (scheme) => scheme.toLowerCase()))

// toml_edit writes a string with none of these as it is, in double quotes,
// and others as its releases have differed on.
const isPlain = (value) => value !== '' && ![...value].some((char) => char <= '\u001F' || char === '\u007F' || char === '"' || char === '\\')

function readField(entry, field, where) {
  const value = string(entry[field], where)
  if (!isPlain(value)) throw new LockfileError(`${quote(value)} is empty, or has a quote, backslash or control character, which this reader does not take`, where)
  if ((field === 'checksum' || field === 'integrity') && !isHexSha256(value)) throw new LockfileError(`${quote(value)} is not a hex sha256`, where)
  if (field === 'rev' && !isCommit(value)) throw new LockfileError(`${quote(value)} is not a full commit hash, as Soldeer writes`, where)
  if (field === 'url' && !isUrl(value)) throw new LockfileError(`${quote(value)} is not an http(s) URL`, where)
  return value
}

function readEntry(entry, index) {
  let where = `dependencies[${index}]`
  if (!isTable(entry)) throw new LockfileError('expected a table', where)
  if (typeof entry.name === 'string' && isPlain(entry.name)) where = at('dependencies', entry.name)
  for (const key of Object.keys(entry)) {
    if (key === 'source') throw new LockfileError('a field of Soldeer 0.3 and older, whose entries 0.4 and later do not read', at(where, key))
    if (!FIELDS.includes(key)) throw new LockfileError(`unsupported field ${quote(key)}`, at(where, key))
  }
  if (entry.url !== undefined && entry.git !== undefined) throw new LockfileError('both a url and a git repository, which Soldeer refuses', where)
  let type = 'http'
  if (entry.url === undefined) type = entry.git === undefined ? 'private' : 'git'
  const read = { type }
  for (const field of KINDS[type]) {
    if (entry[field] === undefined) throw new LockfileError(`expected ${field}, which Soldeer requires of an entry with ${HAVING[type]}`, where)
    read[field] = readField(entry, field, at(where, field))
  }
  const other = FIELDS.find((field) => entry[field] !== undefined && !KINDS[type].includes(field))
  if (other !== undefined) throw new LockfileError(`a field Soldeer does not write for an entry with ${HAVING[type]}`, at(where, other))
  return [read, where]
}

// The text toml_edit's to_string_pretty makes of what was read.
function layout(version, entries) {
  const head = version === undefined ? [] : [`version = ${version}`]
  if (entries.length === 0) return `${[...head, 'dependencies = []'].join('\n')}\n`
  const tables = entries.map((entry) => ['[[dependencies]]', ...KINDS[entry.type].map((field) => `${field} = "${entry[field]}"`)].join('\n'))
  return `${[...head, ...tables].join('\n\n')}\n`
}

function checkLayout(text, expected) {
  if (text === expected) return
  const [have, want] = [text.split('\n'), expected.split('\n')]
  const line = want.findIndex((item, index) => item !== have[index])
  if (line === -1) throw new LockfileError(`line ${want.length}: expected the end of the file, as Soldeer writes it`)
  if (line === have.length) throw new LockfileError(`line ${line}: expected a newline at its end, as Soldeer writes it`)
  throw new LockfileError(`line ${line + 1}: expected ${quote(want[line])}, as Soldeer writes it, found ${quote(have[line])}`)
}

export function parseSoldeerLockfile(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const { config } = checkOptions(options, ['config'])
  const data = parseToml(text)
  const extra = Object.keys(data).find((key) => key !== 'version' && key !== 'dependencies')
  if (extra !== undefined) throw new LockfileError(`unsupported field ${quote(extra)}`, at('', extra))
  const { version } = data
  if (version !== undefined && version !== 1 && version !== 2) throw new LockfileError('expected 1, for Soldeer 0.11 and older, or 2, the formats Soldeer 0.12 knows', 'version')
  if (!Array.isArray(data.dependencies)) throw new LockfileError('expected an array of tables, which Soldeer requires', 'dependencies')
  const dependencies = Object.create(null)
  const entries = []
  const installed = new Map()
  for (const [index, entry] of data.dependencies.entries()) {
    const [read, where] = readEntry(entry, index)
    if (read.name in dependencies) throw new LockfileError('a second entry of the name, where Soldeer writes one', where)
    const last = entries.at(-1)?.name
    if (last !== undefined && compareCodePoints(last, read.name) > 0) throw new LockfileError(`after ${quote(last)}, where Soldeer sorts entries by name`, where)
    // Soldeer installs each in `dependencies/<name>-<version>`, sanitized.
    claimFolder(installed, `${read.name}-${read.version}`, read.name, where)
    dependencies[read.name] = read
    entries.push(read)
  }
  // As read, as an object lists a name like `9` first.
  checkLayout(text, layout(version, entries))
  if (config !== undefined) checkConfig(config, dependencies)
  return { lockfileVersion: version ?? 1, dependencies }
}
