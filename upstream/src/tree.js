import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const BLOCK = 512
const MAX_UNPACKED_BYTES = 2 ** 30

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

// `<length> <key>=<value>\n`, the length counting the whole record.
function paxRecords(body) {
  const text = Buffer.from(body).toString('latin1')
  const records = {}
  for (let at = 0; at < text.length;) {
    const space = text.indexOf(' ', at)
    const length = Number(text.slice(at, space))
    const end = at + length
    if (!/^[1-9]\d*$/u.test(text.slice(at, space)) || end > text.length || text[end - 1] !== '\n') return null
    const record = text.slice(space + 1, end - 1)
    const equals = record.indexOf('=')
    if (equals < 1) return null
    records[record.slice(0, equals)] = record.slice(equals + 1)
    at = end
  }
  return records
}

// A directory's id, or null for one with nothing in it, which git does not
// keep: a submodule is written as one.
function treeId(dir) {
  const entries = []
  for (const [name, entry] of dir) {
    const id = entry instanceof Map ? treeId(entry) : entry.id
    if (id === null) return null
    entries.push({ mode: entry instanceof Map ? '40000' : entry.mode, name, id, key: entry instanceof Map ? `${name}/` : name })
  }
  if (entries.length === 0) return null
  entries.sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)))
  return objectId('tree', Buffer.concat(entries.flatMap(({ mode, name, id }) => [Buffer.from(`${mode} ${name}\0`, 'latin1'), id])))
}

// The id of the git tree a gzipped tarball holds, as `git archive` writes
// one, under a single top directory: a file's mode is its exec bit, a
// symlink's blob its target. Where there is no such tree, a reason, which
// is never an id: a tarball cannot show a submodule's commit.
export function gitTreeOfTarball(gzipped) {
  let bytes
  try {
    bytes = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch {
    return 'no tree: not gzip, or larger than 1 GiB unpacked'
  }
  const root = new Map()
  let top
  let pax = {}
  for (let at = 0; ;) {
    const header = bytes.subarray(at, at + BLOCK)
    if (header.length < BLOCK) return 'no tree: the tarball is cut short'
    if (header.every((byte) => byte === 0)) break
    const size = octal(header, 124, 136)
    const body = bytes.subarray(at + BLOCK, at + BLOCK + size)
    if (body.length !== size) return 'no tree: the tarball is cut short'
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCodePoint(header[156])
    if (type === 'g') continue // git's own: the commit, for a commit's tarball
    if (type === 'x') {
      pax = paxRecords(body)
      if (pax === null) return 'no tree: a malformed pax header'
      continue
    }
    const prefix = field(header, 345, 500)
    const path = pax.path ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    const target = pax.linkpath ?? field(header, 157, 257)
    pax = {}
    const [first, ...parts] = path.replace(/\/$/u, '').split('/')
    top ??= first
    const name = parts.pop()
    if (first !== top || (name === undefined && type !== '5') || parts.some((part) => ['', '.', '..'].includes(part))) return `no tree: an entry outside one top directory, ${JSON.stringify(path)}`
    let dir = root
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Map())
      dir = dir.get(part)
      if (!(dir instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
    }
    if (name === undefined) continue
    if (type === '5') {
      if (!dir.has(name)) dir.set(name, new Map())
      if (!(dir.get(name) instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
      continue
    }
    if (dir.has(name)) return `no tree: ${JSON.stringify(path)} twice`
    if (type === '0') dir.set(name, { mode: octal(header, 100, 108) & 0o100 ? '100755' : '100644', id: objectId('blob', body) })
    else if (type === '2') dir.set(name, { mode: '120000', id: objectId('blob', Buffer.from(target, 'latin1')) })
    else return `no tree: an entry of type ${JSON.stringify(type)}`
  }
  if (top === undefined) return 'no tree: an empty tarball'
  const id = root.size === 0 ? objectId('tree', Buffer.alloc(0)) : treeId(root)
  return id === null ? 'no tree: an empty directory, as a submodule is written' : id.toString('hex')
}
