import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import { isSha1, matches } from './args.js'

const BLOCK = 512
const MAX_UNPACKED_BYTES = 2 ** 30
// Only what git writes is read: anything else, a pax `size` or a mode of
// 0000, would be extracted as it is not hashed. Modes are as its umask,
// 002 or 022, leaves them: a file 0664 or 0644, 0775 or 0755 executable;
// a directory 0775 or 0755; a symlink 0777.
const PAX_KEYS = new Set(['path', 'linkpath'])
const MODES = { 0: [0o664, 0o644, 0o775, 0o755], 2: [0o777], 5: [0o775, 0o755] }
// The top directory is not hashed, so it is held to GitHub's name for it,
// owner-repo-id: another, `..\..`, `C:` or a Windows device such as
// `con.txt`, could take an extractor elsewhere.
const isTop = matches(/^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[\da-z][\w.-]*$/iu)

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
export const objectId = (type, content) => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest()
const checksum = (header) => header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
const isZero = (bytes) => bytes.every((byte) => byte === 0)

// `<length> <key>=<value>\n`, the length counting the whole record. A NUL
// would end a path for an extractor, and a name in a tree for git.
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
    if (equals < 1 || record.includes('\0')) return null
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

// Git sorts a subtree as if its name ended in `/`.
function treeId(dir) {
  const entries = [...dir].map(([name, entry]) => (entry instanceof Map ? { mode: '40000', name, id: treeId(entry) } : { ...entry, name }))
  const keyed = entries.map((entry) => [entry.mode === '40000' ? `${entry.name}/` : entry.name, entry])
  keyed.sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
  return objectId('tree', Buffer.concat(keyed.flatMap(([, { mode, name, id }]) => [Buffer.from(`${mode} ${name}\0`, 'latin1'), id])))
}

const EMPTY_TREE = objectId('tree', Buffer.alloc(0)).toString('hex')
const isName = matches(/^[^\0/]+$/u)
const isEntry = (entry) => isName(entry?.path) && isSha1(entry.sha)
const nameOf = (path) => Buffer.from(path).toString('latin1')
const subtree = (sha) => ({ mode: '40000', id: Buffer.from(sha, 'hex') })

// A subtree with nothing in it but subtrees like it, down to the empty
// tree: its listing, read as subtrees alone, hashes to its id.
async function holdsNothing(sha, listed) {
  if (sha === EMPTY_TREE) return true
  const entries = await listed(sha)
  if (treeId(new Map(entries.map((entry) => [entry.name, subtree(entry.sha)]))).toString('hex') !== sha) return false
  for (const entry of entries) if (!await holdsNothing(entry.sha, listed)) return false
  return true
}

const lf = (body) => Buffer.from(Buffer.from(body).toString('latin1').replaceAll('\r\n', '\n'), 'latin1')

// Where a directory's id is not the one listed, its listing names what
// `git archive` wrote otherwise. A subtree with no file in it, which only
// plumbing makes, it leaves out: one is put back only once its own listings
// show it holds nothing. A file marked `eol=crlf` it writes with CRLF: one
// is taken back to LF where that is the blob listed, and added to `mended`.
async function mend(dir, sha, listed, mended) {
  for (const entry of await listed(sha)) {
    const here = dir.get(entry.name)
    if (entry.type === 'tree') {
      if (here instanceof Map && treeId(here).toString('hex') !== entry.sha) await mend(here, entry.sha, listed, mended)
      else if (here === undefined && await holdsNothing(entry.sha, listed)) dir.set(entry.name, subtree(entry.sha))
    } else if (entry.type === 'blob' && here?.body && here.id.toString('hex') !== entry.sha) {
      const body = lf(here.body)
      const id = body.length < here.body.length ? objectId('blob', body) : here.id
      if (id.toString('hex') !== entry.sha) continue
      dir.set(entry.name, { ...here, id, body })
      mended.push({ at: here.at, body })
    }
  }
}

// The tar again with each mended file's body in place of the one it had,
// its header's size and checksum written over as git writes them, gzipped.
function repack(tar, mended) {
  const parts = []
  let from = 0
  for (const { at, body } of mended.toSorted((a, b) => a.at - b.at)) {
    const header = Buffer.from(tar.subarray(at, at + BLOCK))
    const size = octal(header, 124, 136)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    header.write(`${checksum(header).toString(8).padStart(7, '0')}\0`, 148, 'latin1')
    parts.push(tar.subarray(from, at), header, body, Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK - body.length))
    from = at + BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  parts.push(tar.subarray(from))
  return gzipSync(Buffer.concat(parts))
}

// The entries of a gzipped tarball as `git archive` writes one, under a
// single top directory, as nested Maps: a file's mode is its exec bit, a
// symlink's blob its target, and a file keeps its body and where its
// header is. Where there is no such tree, a reason.
function readTar(gzipped) {
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
    const start = at
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCodePoint(header[156])
    if (type === 'x') {
      const records = paxRecords(body)
      if (records === null) return 'no tree: a malformed pax header'
      const other = [...records.keys()].find((key) => !PAX_KEYS.has(key))
      if (other !== undefined) return `no tree: a pax record git does not write, ${JSON.stringify(other)}`
      if (pax !== null) return 'no tree: two pax headers for one entry'
      pax = records
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
    if (!isTop(first) || first !== top || name === undefined || [...parts, name].some((part) => ['', '.', '..'].includes(part))) return `no tree: an entry outside one top directory, ${JSON.stringify(path)}`
    let dir = root
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Map())
      dir = dir.get(part)
      if (!(dir instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
    }
    if (name === null) continue
    if (dir.has(name)) return `no tree: ${JSON.stringify(path)} twice`
    dir.set(name, type === '0' ? { mode: mode & 0o100 ? '100755' : '100644', id: objectId('blob', body), body, at: start } : { mode: '120000', id: objectId('blob', Buffer.from(target, 'latin1')) })
  }
  return top === undefined ? 'no tree: an empty tarball' : { root, tar: bytes }
}

// The id of the git tree a gzipped tarball holds, as `git archive` writes
// one, and the tarball to keep. What a tarball cannot show comes from
// `list`, which answers a listing of a tree by its id, as GitHub's trees
// API does ({ type, path, sha } entries), walked from `expected`: a
// submodule's commit for an empty directory, and, where the id comes out
// otherwise, what mend finds. The id is `expected` only if those are right,
// and then the tarball is the one given, or, with a file mended, the one
// repacked with it, which is the tree's own. Where there is no such tree,
// a reason, never an id.
export async function readTreeTarball(gzipped, { expected, list } = {}) {
  const read = readTar(gzipped)
  if (typeof read === 'string') return { id: read, bytes: gzipped }
  const { root, tar } = read
  const listed = async (sha) => (list && isSha1(sha) ? await list(sha) : [])
    .filter(isEntry)
    .map((entry) => ({ ...entry, name: nameOf(entry.path) }))
  for (const [dir, name, path] of emptyDirs(root)) {
    let sha = expected
    const parts = path.split('/')
    for (const [i, part] of parts.entries()) {
      const type = i === parts.length - 1 ? 'commit' : 'tree'
      sha = (await listed(sha)).find((entry) => entry.type === type && entry.name === part)?.sha
    }
    if (!isSha1(sha)) return { id: `no tree: an empty directory, ${JSON.stringify(path)}, and no submodule there`, bytes: gzipped }
    dir.set(name, { mode: '160000', id: Buffer.from(sha, 'hex') })
  }
  const id = treeId(root).toString('hex')
  if (id === expected) return { id, bytes: gzipped }
  const mended = []
  await mend(root, expected, listed, mended)
  const mendedId = treeId(root).toString('hex')
  return { id: mendedId, bytes: mendedId === expected && mended.length > 0 ? repack(tar, mended) : gzipped }
}

export const gitTreeOfTarball = async (gzipped, options) => (await readTreeTarball(gzipped, options)).id

// GitHub lists a subtree's mode as `040000`, which git writes `40000`.
const LISTED = new Set(['100644 blob', '100755 blob', '120000 blob', '040000 tree', '160000 commit'])

// The id of the tree a listing such as GitHub's names, its entries
// { path, mode, type, sha }, or null where one is not an entry a tree can
// hold, or a name is there twice.
export function gitTreeOfListing(entries) {
  if (!entries.every((entry) => isEntry(entry) && LISTED.has(`${entry.mode} ${entry.type}`))) return null
  const dir = new Map(entries.map(({ path, mode, sha }) => [nameOf(path), { mode: mode.replace(/^0/u, ''), id: Buffer.from(sha, 'hex') }]))
  return dir.size === entries.length ? treeId(dir).toString('hex') : null
}
