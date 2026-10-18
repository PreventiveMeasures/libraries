import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpackStream } from '@preventive/archive/tar.js'

import { isSha1, matches } from './args.js'
import { withAttributes, writtenWithCrlf } from './attributes.js'

const MAX_UNPACKED_BYTES = 2 ** 30
// The tar is read a chunk at a time, each entry taken as it is read, so no
// more of them are held than one chunk's: a header that repeats an earlier
// one, which git never writes, is refused where it stands.
const CHUNK_BYTES = 2 ** 20
// Read by @preventive/archive, which holds a tarball to its checks -- each
// header's checksum and fields, the padding and the end, pax records of
// which none repeats, names and link targets that stay within it, no name
// twice as another entry -- and past those to only what git writes:
// anything else, a pax `size` or a mode of 0000, would be extracted as it
// is not hashed. POSIX ustar headers, as under GNU's magic a reader that
// knows none takes GNU's own bytes for a name's prefix, their numbers as
// octal digits; no extended header but an entry's own pax one; type flags
// and modes as stored. Modes are as
// its umask, 002 or 022, leaves them: a file 0664 or 0644, 0775 or 0755
// executable; a directory 0775 or 0755; a symlink 0777.
const PAX_KEYS = new Set(['path', 'linkpath'])
const MODES = { 0: [0o664, 0o644, 0o775, 0o755], 2: [0o777], 5: [0o775, 0o755] }
// The extended headers git does not write, by the type a tar names them by.
const FLAGS = { global: 'g', longname: 'L', longlink: 'K' }
// The top directory is not hashed, so it is held to GitHub's name for it,
// owner-repo-id: another, `..\..`, `C:` or a Windows device such as
// `con.txt`, could take an extractor elsewhere.
const isTop = matches(/^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[\da-z][\w.-]*$/iu)

export const objectId = (type, content) => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest()

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
// Names are kept as latin1 strings of their UTF-8, a char per byte, so they
// sort and hash as the bytes git has.
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

// One entry of a tarball into `root`, the tree being built, whose top
// directory is `top`, the first entry's: a reason where git writes no such
// entry there, else nothing.
function take(root, { storedName, storedLinkname, typeflag, storedMode, uid, gid, uname, gname, data, pax, extended, magic, base256 }, top) {
  const path = nameOf(storedName)
  const flag = extended.find(({ kind }) => kind !== 'pax')
  if (flag !== undefined) return `no tree: an entry of type ${JSON.stringify(FLAGS[flag.kind])}`
  if (magic !== 'ustar' || extended.some((header) => header.magic !== 'ustar')) return 'no tree: a header that is not POSIX ustar'
  const other = [...pax.keys()].find((key) => !PAX_KEYS.has(key))
  if (other !== undefined) return `no tree: a pax record git does not write, ${JSON.stringify(other)}`
  if (!Object.hasOwn(MODES, typeflag)) return `no tree: an entry of type ${JSON.stringify(typeflag)}`
  const asGitWrites = MODES[typeflag].includes(storedMode) && path.endsWith('/') === (typeflag === '5')
    && uid === 0 && gid === 0 && uname === 'root' && gname === 'root'
    && base256.length === 0 && extended.every((header) => header.base256.length === 0)
  if (!asGitWrites) return `no tree: a header git does not write, ${JSON.stringify(path)}`
  const [first, ...parts] = path.replace(/\/$/u, '').split('/')
  const name = typeflag === '5' ? null : parts.pop()
  if (!isTop(first) || first !== top || name === undefined || [...parts, name].some((part) => ['', '.', '..'].includes(part))) return `no tree: an entry outside one top directory, ${JSON.stringify(path)}`
  let dir = root
  for (const part of parts) {
    if (!dir.has(part)) dir.set(part, new Map())
    dir = dir.get(part)
    if (!(dir instanceof Map)) return `no tree: a file where a directory is, ${JSON.stringify(path)}`
  }
  if (name === null) return
  if (dir.has(name)) return `no tree: ${JSON.stringify(path)} twice`
  dir.set(name, typeflag === '0' ? { mode: storedMode & 0o100 ? '100755' : '100644', id: objectId('blob', data), body: data } : { mode: '120000', id: objectId('blob', Buffer.from(storedLinkname)) })
}

// The id of the git tree a gzipped tarball holds, as `git archive` writes
// one, under a single top directory: a file's mode is its exec bit, a
// symlink's blob its target. What a tarball cannot show comes from `list`,
// which answers a listing of a tree by its id, as GitHub's trees API does
// ({ type, path, sha } entries), walked from `expected`: a submodule's
// commit for an empty directory, and, where the id comes out otherwise, the
// subtrees with nothing in them it leaves out and the blobs of the files it
// wrote with CRLF for `eol=crlf`. The id is `expected` only if those are
// right. Where there is no such tree, a reason, never an id. A symlink may
// climb `symlinksAbove` levels above the tarball's root, none unless given,
// as @preventive/archive lets it: a subtree's, linking to the tree's root
// as a monorepo package's LICENSE does, as many as it is deep, less one.
export async function gitTreeOfTarball(gzipped, { expected, list, symlinksAbove = 0 } = {}) {
  let tar
  try {
    tar = await decompress(gzipped, 'gzip', { limit: MAX_UNPACKED_BYTES })
  } catch (error) {
    if (error instanceof CompressionError) return 'no tree: not gzip, or larger than 1 GiB unpacked'
    throw error
  }
  const chunks = function* () {
    for (let at = 0; at < tar.length; at += CHUNK_BYTES) yield tar.subarray(at, at + CHUNK_BYTES)
  }
  const root = new Map()
  let top
  try {
    for await (const entry of unpackStream(chunks(), { symlinksAbove })) {
      const reason = take(root, entry, top ??= nameOf(entry.storedName).split('/')[0])
      if (reason !== undefined) return reason
    }
  } catch (error) {
    if (error instanceof ArchiveError) return `no tree: ${error.message}`
    throw error
  }
  if (top === undefined) return 'no tree: an empty tarball'
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
