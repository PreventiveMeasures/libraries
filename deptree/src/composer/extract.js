// A package's files as Composer 2 extracts its zip on a host with unzip,
// which it prefers there, under a umask of 0o022, into a directory of its
// own, then moves into its place: the one directory the zip holds at its
// top, `.DS_Store` aside, or else the whole of it. Each package is
// { dirs, files, links, modes }: its directories, its files by path, each
// { data, mode }, its links by path, each to its target as written, and the
// modes of directories unzip sets otherwise than 0o755, `''` the package's
// own.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { DeptreeError, quote } from '../error.js'
import { parentsOf } from '../mount.js'
import { MAX_BYTES } from '../tarball.js'
import { emptyLinksAsFiles, isUnflagged, unzipEntries } from '../zipdir.js'

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const UMASK = 0o022
// MS-DOS and the systems unzip takes as it does, by their DOS attributes;
// and Unix, by the mode in the upper half.
const [FAT, UNIX] = [0, 3]
const LIKE_FAT = new Set([FAT, 6, 11, 14])
const MAX_HOPS = 40
const BLOCK = 512
const decoder = new TextDecoder()
const encoder = new TextEncoder()

const emptyTree = () => ({ dirs: new Set(), files: new Map(), links: new Map(), modes: new Map() })

// Where `path` is in a package, its links followed, as realpath finds it:
// a path within it, `''` the package itself; OUT where it leads out of it;
// and undefined where to nothing, or round a loop.
export const OUT = Symbol('out')
export function realpathIn({ dirs, files, links }, path) {
  const parts = []
  const queue = path.split('/')
  for (let hops = 0; queue.length > 0;) {
    const part = queue.shift()
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return OUT
      parts.pop()
      continue
    }
    const here = [...parts, part].join('/')
    if (links.has(here)) {
      const target = links.get(here)
      if (target.startsWith('/')) return OUT
      if (++hops > MAX_HOPS) return undefined
      queue.unshift(...target.split('/'))
      continue
    }
    // A file ends the path, with not even a `/` after it.
    if (!dirs.has(here) && !(files.has(here) && queue.length === 0)) return undefined
    parts.push(part)
  }
  return parts.join('/')
}

// unzip keeps a link as it is, wherever it leads; one that leads out of
// the package, into another's or anywhere else, is refused.
function checkLinks(tree, where) {
  for (const path of tree.links.keys()) {
    if (realpathIn(tree, path) === OUT) throw new DeptreeError(`${quote(path)} links out of the package, which is not supported`, where)
  }
  return tree
}

const field = (header, start, end) => {
  const bytes = header.subarray(start, end)
  const nul = bytes.indexOf(0)
  return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul))
}

// unzip writes a link with no target, which git can hold and no
// filesystem, as an empty file of the link's mode, which git writes 0o777
// in a zip; the tar reader refuses it. Each such entry of the tarball, as
// upstream has held it to what git writes, made a file where it is, its
// name kept: a ustar header of a link with no target, but after a pax
// header, which is left to the reader.
function emptyTarLinksAsFiles(tar) {
  const names = new Set()
  for (let at = 0, pax = false; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (header[156] === 0x32 && header[157] === 0 && !pax) {
      header[156] = 0x30
      header.fill(0x20, 148, 156)
      header.set(encoder.encode(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `), 148)
      const prefix = field(header, 345, 500)
      names.add(prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    }
    pax = header[156] === 0x78
    at += BLOCK + Math.ceil(Number.parseInt(field(header, 124, 136), 8) / BLOCK) * BLOCK
  }
  return names
}

// GitHub's archive of a commit, which @preventive/upstream has held to the
// commit's tree, as unzip extracts GitHub's zipball of it, which holds the
// same, as `git archive` writes it: each directory 0o755 and each file
// 0o644, as git records no mode for them in a zip, but an executable,
// which keeps git's 0o755; each link as a link, but one with no target, an
// empty file of 0o777; and every directory, empty or not, made.
export async function fromArchive(bytes, where) {
  let entries
  let emptied
  try {
    const tar = await decompress(bytes, 'gzip', { limit: MAX_BYTES })
    emptied = emptyTarLinksAsFiles(tar)
    entries = unpack(tar)
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`GitHub's archive cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  const tree = emptyTree()
  for (const { name, type, mode, data, linkname } of entries) {
    for (const dir of parentsOf(name)) tree.dirs.add(dir)
    if (type === 'directory') tree.dirs.add(name)
    else if (type === 'file') tree.files.set(name, { data, mode: emptied.has(name) ? 0o777 : mode & 0o100 ? 0o755 : 0o644 })
    else if (type === 'symlink') tree.links.set(name, linkname)
    else throw new DeptreeError(`${quote(name)} is a ${type} in GitHub's archive`, where)
  }
  return checkLinks(topDir(tree, where), where)
}

// unix/unix.c's mapattr, of UnZip 6.0: a mode made on Unix as it is, but
// for its setuid, setgid and sticky bits; one made on MS-DOS that agrees
// with the DOS attributes as it is too; any other of the DOS attributes,
// read-only and directory, with the umask taken off. undefined for a system
// it reads by an extra field, or no mode at all.
function infoZipMode({ system, attributes }, isDir) {
  const upper = attributes >>> 16
  if (system === UNIX) return upper === 0 ? undefined : upper
  if (!LIKE_FAT.has(system)) return undefined
  const dos = (attributes & 0xff) | (isDir ? 0x10 : 0)
  const bits = (Number(!(dos & 0x01)) << 1) | ((dos & 0x10) >> 4)
  const kept = system === FAT ? upper : 0
  if ((kept & 0o700) === (0o400 | (bits << 6))) return kept
  return (0o444 | (bits << 6) | (bits << 3) | bits) & ~UMASK
}

// The one directory at the top of what unzip extracted, `.DS_Store`
// aside, moved into the package's place, the rest left behind; or else
// all of it, in a directory of the umask's 0o755. A link alone there, which
// Composer would move into the package's place, is refused.
function topDir(tree, where) {
  const tops = new Set([...tree.dirs, ...tree.files.keys(), ...tree.links.keys()].map((path) => path.split('/')[0]).filter((name) => name !== '.DS_Store'))
  const [top] = tops
  if (tops.size === 1 && tree.links.has(top)) throw new DeptreeError(`its zip holds the link ${quote(top)} alone, which Composer would install in the package's place, which is not supported`, where)
  if (tops.size !== 1 || !tree.dirs.has(top)) return tree
  const inside = (path) => (path.startsWith(`${top}/`) ? path.slice(top.length + 1) : undefined)
  const under = (map) => new Map([...map].map(([path, value]) => [inside(path), value]).filter(([path]) => path !== undefined))
  const modes = under(tree.modes)
  if (tree.modes.has(top)) modes.set('', tree.modes.get(top))
  return { dirs: new Set([...tree.dirs].map(inside).filter((path) => path !== undefined)), files: under(tree.files), links: under(tree.links), modes }
}

// A zip held to the shasum the lockfile records, as unzip extracts it, a
// link made on Unix with no target an empty file of its mode, as unzip
// writes one. What the archive reader refuses is refused, and what unzip
// would ask about or read otherwise than it: a name twice, which it asks
// whether to replace, and a name past ASCII not flagged UTF-8, which it
// reads by the system that made it; and what it reads modes of otherwise
// than by the two ways it reads them, an entry with no mode or of a system
// it reads by an extra field, and a link not made on Unix, which it writes
// as a file.
export async function fromZip(bytes, where) {
  const tree = emptyTree()
  const seen = new Set()
  for (const { entry, record } of await unzipEntries(emptyLinksAsFiles(bytes), where)) {
    const here = `${where}: ${quote(entry.storedName)}`
    if (isUnflagged(record)) throw new DeptreeError('a name not flagged UTF-8, which unzip reads by the system that made it, is not supported', here)
    if (seen.has(entry.name)) throw new DeptreeError('a name twice in the zip, which unzip asks whether to replace, is not supported', here)
    seen.add(entry.name)
    if (entry.name === '.') continue
    const mode = infoZipMode(record, entry.type === 'directory')
    if (mode === undefined) throw new DeptreeError('an entry unzip reads no mode of, or one by an extra field, is not supported', here)
    for (const dir of parentsOf(entry.name)) tree.dirs.add(dir)
    if (entry.type === 'symlink') {
      if (record.system !== UNIX || (mode & S_IFMT) !== S_IFLNK) throw new DeptreeError('a link not made on Unix, which unzip writes as a file, is not supported', here)
      tree.links.set(entry.name, entry.linkname)
    } else if (entry.type === 'directory') {
      tree.dirs.add(entry.name)
      if ((mode & 0o777) !== 0o755) tree.modes.set(entry.name, mode & 0o777)
    } else {
      tree.files.set(entry.name, { data: entry.data, mode: mode & 0o777 })
    }
  }
  return checkLinks(topDir(tree, where), where)
}
