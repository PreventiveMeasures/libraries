import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import { isSha1, matches } from './args.js'
import { withAttributes, writtenWithCrlf } from './attributes.js'

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
  const nul = header.indexOf(0, start)
  return header.toString('latin1', start, nul === -1 || nul > end ? end : nul)
}
const octal = (header, start, end) => {
  const text = field(header, start, end).trim()
  return /^[0-7]{1,12}$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN
}
export const objectId = (type, content) => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest()
// The checksum field itself counts as spaces.
function checksum(header) {
  let sum = 8 * 0x20
  for (let i = 0; i < BLOCK; i++) if (i < 148 || i >= 156) sum += header[i]
  return sum
}
const isZero = (bytes) => bytes.every((byte) => byte === 0)

// `<length> <key>=<value>\n`, the length counting the whole record. A NUL
// would end a path for an extractor, and a name in a tree for git.
function paxRecords(body) {
  const text = body.toString('latin1')
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

// Git sorts a subtree as if its name ended in `/`. With `memo`, each
// directory's id is kept there, for one that does not change after.
export function treeId(dir, memo) {
  if (memo?.has(dir)) return memo.get(dir)
  const entries = [...dir].map(([name, entry]) => (entry instanceof Map ? { mode: '40000', name, id: treeId(entry, memo) } : { ...entry, name }))
  const keyed = entries.map((entry) => [entry.mode === '40000' ? `${entry.name}/` : entry.name, entry])
  keyed.sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
  const tree = objectId('tree', Buffer.concat(keyed.flatMap(([, { mode, name, id }]) => [Buffer.from(`${mode} ${name}\0`, 'latin1'), id])))
  memo?.set(dir, tree)
  return tree
}

const EMPTY_TREE = objectId('tree', Buffer.alloc(0)).toString('hex')
const isName = matches(/^[^\0/]+$/u)
const isEntry = (entry) => isName(entry?.path) && isSha1(entry.sha)
export const nameOf = (path) => Buffer.from(path).toString('latin1')
export const subtree = (sha) => ({ mode: '40000', id: Buffer.from(sha, 'hex') })

// A subtree with nothing in it but subtrees like it, down to the empty
// tree: its listing, read as subtrees alone, hashes to its id.
async function holdsNothing(sha, listed) {
  if (sha === EMPTY_TREE) return true
  const entries = await listed(sha)
  if (treeId(new Map(entries.map((entry) => [entry.name, subtree(entry.sha)]))).toString('hex') !== sha) return false
  for (const entry of entries) if (!await holdsNothing(entry.sha, listed)) return false
  return true
}

const CHUNK = 64 * 1024

// The id of the blob that `eol=crlf`, a CR written before each LF with
// none, writes out as these bytes: theirs with each LF's CR taken out,
// hashed a chunk at a time, the bytes only read. Null where no blob writes
// them so: an LF with no CR before it, a CR before that CR, or no LF at
// all. Most files are passed over at their first LF, a binary one with
// none at once.
function crlfBlobId(written) {
  const first = written.indexOf(0x0a)
  if (first < 1 || written[first - 1] !== 0x0d) return null
  let lfs = 0
  for (let i = first; i < written.length; i++) {
    if (written[i] !== 0x0a) continue
    if (written[i - 1] !== 0x0d || written[i - 2] === 0x0d) return null
    lfs++
  }
  const hash = createHash('sha1').update(`blob ${written.length - lfs}\0`)
  const chunk = Buffer.allocUnsafe(CHUNK)
  let at = 0
  for (let i = 0; i < written.length; i++) {
    if (written[i] === 0x0d && written[i + 1] === 0x0a) continue
    chunk[at++] = written[i]
    if (at === CHUNK) {
      hash.update(chunk)
      at = 0
    }
  }
  return hash.update(chunk.subarray(0, at)).digest()
}

// Where a directory's id is not the one listed, its listing names what
// `git archive` wrote otherwise, as a checkout writes it. A subtree with no
// file in it, which only plumbing makes, it leaves out: one is put back
// only once its own listings show it holds nothing. A file marked
// `eol=crlf` it writes with CRLF where git has LF: one is hashed as the
// blob listed, its bytes left as written, where that blob writes them and
// the tree's .gitattributes have git write it so.
async function mend(dir, sha, listed, base = '', above = []) {
  const own = dir.get('.gitattributes')
  const attributes = withAttributes(above, base, own && (own.body ?? null))
  for (const entry of await listed(sha)) {
    const here = dir.get(entry.name)
    if (entry.type === 'tree') {
      if (here instanceof Map && treeId(here).toString('hex') !== entry.sha) await mend(here, entry.sha, listed, `${base}${entry.name}/`, attributes)
      else if (here === undefined && await holdsNothing(entry.sha, listed)) dir.set(entry.name, subtree(entry.sha))
    } else if (entry.type === 'blob' && here?.body && here.id.toString('hex') !== entry.sha
      && crlfBlobId(here.body)?.toString('hex') === entry.sha && writtenWithCrlf(attributes, `${base}${entry.name}`, here.body)) {
      dir.set(entry.name, { ...here, id: Buffer.from(entry.sha, 'hex') })
    }
  }
}

const gunzipped = promisify(gunzip)

// The entries of a gzipped tarball as `git archive` writes one, under a
// single top directory, as a Map of its entries: a Map of each directory's,
// a file's mode its exec bit, a symlink's blob its target, and a copy of
// the `body` of each file `keep` takes by its name; with `bodies`, every
// file's body, as the tarball has it. A commit's archive leads with git's
// global header naming it, taken only where `commit` is that commit. Where
// there is no such tree, a reason, never entries.
export async function readTarball(gzipped, { commit, keep = () => false, bodies = false } = {}) {
  let bytes
  try {
    bytes = await gunzipped(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES })
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
    if (header.toString('latin1', 257, 265) !== 'ustar\u000000') return 'no tree: a header that is not POSIX ustar'
    if (octal(header, 148, 156) !== checksum(header)) return 'no tree: a header that fails its checksum'
    const size = octal(header, 124, 136)
    const body = bytes.subarray(at + BLOCK, at + BLOCK + size)
    if (body.length !== size) return 'no tree: the tarball is cut short'
    const first = at === 0
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCodePoint(header[156])
    if (type === 'g' && first && commit !== undefined && field(header, 0, 100) === 'pax_global_header') {
      const records = paxRecords(body)
      if (records?.size !== 1 || records.get('comment') !== commit) return `no tree: a global header that does not name ${commit}`
      continue
    }
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
    const [head, ...parts] = path.replace(/\/$/u, '').split('/')
    top ??= head
    const name = type === '5' ? null : parts.pop()
    if (!isTop(head) || head !== top || name === undefined || [...parts, name].some((part) => ['', '.', '..'].includes(part))) return `no tree: an entry outside one top directory, ${JSON.stringify(path)}`
    let dir = root
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Map())
      dir = dir.get(part)
      if (!(dir instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
    }
    if (name === null) continue
    if (dir.has(name)) return `no tree: ${JSON.stringify(path)} twice`
    // A copy, but for `bodies`, so the tarball itself is not kept for it.
    dir.set(name, type === '0' ? { mode: mode & 0o100 ? '100755' : '100644', id: objectId('blob', body), ...(bodies ? { body } : keep(name) && { body: Buffer.from(body) }) } : { mode: '120000', id: objectId('blob', Buffer.from(target, 'latin1')) })
  }
  if (top === undefined) return 'no tree: an empty tarball'
  return root
}

// The id of the git tree a gzipped tarball holds, as readTarball reads it.
// What a tarball cannot show comes from `list`, which answers a listing of
// a tree by its id, as GitHub's trees API does ({ type, path, sha }
// entries), walked from `expected`: a submodule's commit for an empty
// directory, and, where the id comes out otherwise, the subtrees with
// nothing in them it leaves out and the blobs of the files it wrote with
// CRLF for `eol=crlf`. The id is `expected` only if those are right. Where
// there is no such tree, a reason, never an id.
export async function gitTreeOfTarball(gzipped, { expected, list } = {}) {
  const root = await readTarball(gzipped, { bodies: true })
  if (typeof root === 'string') return root
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
    if (!isSha1(sha)) return `no tree: an empty directory, ${JSON.stringify(path)}, and no submodule there`
    dir.set(name, { mode: '160000', id: Buffer.from(sha, 'hex') })
  }
  const id = treeId(root).toString('hex')
  if (id === expected) return id
  await mend(root, expected, listed)
  return treeId(root).toString('hex')
}

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
