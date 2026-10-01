import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { isSha1 } from './args.js'

const BLOCK = 512
const MAX_UNPACKED_BYTES = 2 ** 30
// Only what git writes is read: anything else, a pax `size` or a mode of
// 0000, would be extracted as it is not hashed. Modes are as its umask,
// 002 or 022, leaves them: a file 0664 or 0644, 0775 or 0755 executable;
// a directory 0775 or 0755; a symlink 0777.
const PAX_KEYS = { x: new Set(['path', 'linkpath']), g: new Set(['comment']) }
const MODES = { 0: [0o664, 0o644, 0o775, 0o755], 2: [0o777], 5: [0o775, 0o755] }

// Names are kept as latin1 strings, a char per byte, so they sort and hash
// as the bytes git has.
const field = (header, start, end) => {
  const bytes = header.subarray(start, end)
  const nul = bytes.indexOf(0)
  return Buffer.from(nul === -1 ? bytes : bytes.subarray(0, nul)).toString('latin1')
}
const octal = (header, start, end) => {
  const text = field(header, start, end).trim()
  return /^[0-7]{1,12}$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN
}
const objectId = (type, content) => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest()
const checksum = (header) => header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
const isZero = (bytes) => bytes.every((byte) => byte === 0)

// `<length> <key>=<value>\n`, the length counting the whole record.
function paxRecords(body) {
  const text = Buffer.from(body).toString('latin1')
  const records = new Map()
  for (let at = 0; at < text.length;) {
    const space = text.indexOf(' ', at)
    const length = text.slice(at, space)
    const end = at + Number(length)
    if (!/^[1-9]\d*$/u.test(length) || end > text.length || text[end - 1] !== '\n') return null
    const record = text.slice(space + 1, end - 1)
    const equals = record.indexOf('=')
    if (equals < 1) return null
    records.set(record.slice(0, equals), record.slice(equals + 1))
    at = end
  }
  return records
}

// Git keeps no empty directory: in a tarball, one is a submodule. Each as
// [the directory holding it, its name, its path].
function emptyDirs(dir, prefix = '') {
  return [...dir].flatMap(([name, entry]) => {
    if (!(entry instanceof Map)) return []
    const path = `${prefix}${name}`
    return entry.size === 0 ? [[dir, name, path]] : emptyDirs(entry, `${path}/`)
  })
}

function treeId(dir) {
  const entries = [...dir].map(([name, entry]) => (entry instanceof Map ? { mode: '40000', name, id: treeId(entry), key: `${name}/` } : { ...entry, name, key: name }))
  entries.sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)))
  return objectId('tree', Buffer.concat(entries.flatMap(({ mode, name, id }) => [Buffer.from(`${mode} ${name}\0`, 'latin1'), id])))
}

// The id of the git tree a gzipped tarball holds, as `git archive` writes
// one, under a single top directory: a file's mode is its exec bit, a
// symlink's blob its target. A tarball cannot show a submodule's commit:
// `submodules`, asked with the empty directories' paths, answers a Map of
// path to commit, and the id is the asked one only if those are right.
// Where there is no such tree, a reason, which is never an id.
export async function gitTreeOfTarball(gzipped, submodules) {
  let bytes
  try {
    bytes = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch {
    return 'no tree: not gzip, or larger than 1 GiB unpacked'
  }
  const root = new Map()
  let top
  let pax = null
  for (let at = 0; ;) {
    const header = bytes.subarray(at, at + BLOCK)
    if (header.length < BLOCK) return 'no tree: the tarball is cut short'
    if (isZero(header)) {
      if (!isZero(bytes.subarray(at))) return 'no tree: data after the end of the tarball'
      break
    }
    if (Buffer.from(header.subarray(257, 265)).toString('latin1') !== 'ustar\u000000') return 'no tree: a header that is not POSIX ustar'
    if (octal(header, 148, 156) !== checksum(header)) return 'no tree: a header that fails its checksum'
    const size = octal(header, 124, 136)
    const body = bytes.subarray(at + BLOCK, at + BLOCK + size)
    if (body.length !== size) return 'no tree: the tarball is cut short'
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCodePoint(header[156])
    // `g` is git's own, naming the commit of a commit's tarball.
    if (type === 'x' || type === 'g') {
      const records = paxRecords(body)
      if (records === null) return 'no tree: a malformed pax header'
      const other = [...records.keys()].find((key) => !PAX_KEYS[type].has(key))
      if (other !== undefined) return `no tree: a pax record git does not write, ${JSON.stringify(other)}`
      if (type === 'x' && pax !== null) return 'no tree: two pax headers for one entry'
      if (type === 'x') pax = records
      continue
    }
    const prefix = field(header, 345, 500)
    const path = pax?.get('path') ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    const target = pax?.get('linkpath') ?? field(header, 157, 257)
    pax = null
    if (!Object.hasOwn(MODES, type)) return `no tree: an entry of type ${JSON.stringify(type)}`
    const mode = octal(header, 100, 108)
    const asGitWrites = MODES[type].includes(mode) && (type === '0' || size === 0) && path.endsWith('/') === (type === '5')
      && octal(header, 108, 116) === 0 && octal(header, 116, 124) === 0 && field(header, 265, 297) === 'root' && field(header, 297, 329) === 'root'
    if (!asGitWrites) return `no tree: a header git does not write, ${JSON.stringify(path)}`
    const [first, ...parts] = path.replace(/\/$/u, '').split('/')
    top ??= first
    const name = type === '5' ? null : parts.pop()
    if (first !== top || name === undefined || [first, ...parts, name].some((part) => ['', '.', '..'].includes(part))) return `no tree: an entry outside one top directory, ${JSON.stringify(path)}`
    let dir = root
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Map())
      dir = dir.get(part)
      if (!(dir instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
    }
    if (name === null) continue
    if (dir.has(name)) return `no tree: ${JSON.stringify(path)} twice`
    dir.set(name, type === '0' ? { mode: mode & 0o100 ? '100755' : '100644', id: objectId('blob', body) } : { mode: '120000', id: objectId('blob', Buffer.from(target, 'latin1')) })
  }
  if (top === undefined) return 'no tree: an empty tarball'
  const empty = emptyDirs(root)
  const commits = empty.length > 0 && submodules ? await submodules(empty.map(([, , path]) => path)) : new Map()
  for (const [dir, name, path] of empty) {
    const commit = commits.get(path)
    if (!isSha1(commit)) return `no tree: an empty directory, ${JSON.stringify(path)}, and no submodule there`
    dir.set(name, { mode: '160000', id: Buffer.from(commit, 'hex') })
  }
  return treeId(root).toString('hex')
}
