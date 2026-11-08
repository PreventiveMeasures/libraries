// An archive by :http as RemoteFile leaves it: saved as `file.<type>` in a
// directory, extracted there by `tar xf` or `unzip -d` under a umask of
// 0o022, then flattened where that is asked and it holds one directory.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { unzip } from '@preventive/archive/zip.js'
import { DeptreeError, quote } from '../error.js'
import { isGit } from '../soldeer/zip.js'
import { MAX_BYTES } from '../tarball.js'

const startsWith = (bytes, magic) => magic.every((byte, i) => bytes[i] === byte)
const GZIP = [0x1f, 0x8b]
// A zip, with an entry or empty.
const ZIPS = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]]
// What `tar xf` decompresses by its magic too, and is not read here.
const OTHERS = [
  ['bzip2', [0x42, 0x5a, 0x68]], ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ['compress', [0x1f, 0x9d]], ['lzip', [0x4c, 0x5a, 0x49, 0x50]], ['lzma', [0x5d, 0x00, 0x00]],
]

// The setuid, setgid and sticky bits.
const SPECIAL = 0o7000
const UMASK = 0o022

// The names at the archive's root, a directory's that only paths under it
// name among them.
const topsOf = ({ dirs, files, links }) => new Set([...dirs, ...files.keys(), ...links.keys()].map((path) => path.split('/')[0]))

const gitRefusal = (at) => new DeptreeError('a path with a .git in it, which CocoaPods 1.16 leaves out of its cache and those before keep', at)
const dirRefusal = (mode, at) => new DeptreeError(`a directory of mode ${mode.toString(8)}, which its owner cannot list and write in, as CocoaPods' cleaner has to`, at)
const fileRefusal = (mode, at) => new DeptreeError(`a file of mode ${mode.toString(8)}, which its owner cannot read, as CocoaPods' copy has to`, at)

async function tarOf(bytes, where) {
  if (startsWith(bytes, GZIP)) return await decompress(bytes, 'gzip', { limit: MAX_BYTES })
  if (ZIPS.some((magic) => startsWith(bytes, magic))) throw new DeptreeError('its archive is a zip, which bsdtar extracts for `tar xf` and GNU tar does not', where)
  const other = OTHERS.find(([, magic]) => startsWith(bytes, magic))
  if (other !== undefined) throw new DeptreeError(`its archive is compressed with ${other[0]}, which is not read here: only gzip is`, where)
  return bytes
}

// Each entry as tar writes it out: a directory, a file with its bytes and
// its mode under the umask, a link to its target as stored. A hard link is
// a second name for what it links to, and is copied as rsync -a, which
// CocoaPods copies the download into its cache with, and FileUtils.cp_r
// copy one: a file of the same bytes and mode, or a link to the same
// target. What tar would make otherwise on one machine than on another is
// refused: a special bit; a directory its owner cannot list and write in,
// which the cleaner would leave files in; a file its owner cannot read,
// which the copy fails on; a name starting with `._`, which bsdtar on macOS
// makes an extended attribute of; a `.git`, which the copy into the cache
// leaves out from CocoaPods 1.16; a FIFO or a device.
function entriesOf(entries, where) {
  const dirs = new Set()
  const files = new Map()
  const links = new Map()
  for (const entry of entries) {
    const { name, type } = entry
    if (name === '.' || dirs.has(name) || files.has(name) || links.has(name)) continue
    const at = `${where}: ${quote(name)}`
    const segments = name.split('/')
    if (segments.some(isGit)) throw gitRefusal(at)
    if (segments.some((segment) => segment.startsWith('._'))) throw new DeptreeError('a name starting with `._`, which bsdtar on macOS reads as the extended attributes of another', at)
    const mode = type === 'hardlink' ? undefined : entry.mode
    if (mode !== undefined && type !== 'symlink' && (mode & SPECIAL) !== 0) throw new DeptreeError(`a mode of ${mode.toString(8)}, with a bit tar sets or drops by who extracts it`, at)
    if (type === 'directory') {
      if ((mode & 0o700) !== 0o700) throw dirRefusal(mode, at)
      dirs.add(name)
    } else if (type === 'file' || type === 'contiguous-file') {
      if ((mode & 0o400) === 0) throw fileRefusal(mode, at)
      files.set(name, { data: entry.data, mode: mode & 0o777 & ~UMASK })
    } else if (type === 'symlink') {
      links.set(name, entry.linkname)
    } else if (type === 'hardlink') {
      // The archive reader holds a hard link to an earlier entry.
      if (files.has(entry.linkname)) files.set(name, { ...files.get(entry.linkname) })
      else if (links.has(entry.linkname)) links.set(name, links.get(entry.linkname))
      else throw new DeptreeError(`a hard link to ${quote(entry.linkname)}, which is no file or link`, at)
    } else {
      throw new DeptreeError(`a ${type}, which a pod's download cannot hold`, at)
    }
  }
  return { dirs, files, links }
}

async function untarred(bytes, where) {
  try {
    return entriesOf(unpack(await tarOf(bytes, where), { trailingGlobal: true }), where)
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its archive cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
}

// A mode as unzip 6.0's mapattr() makes one: a Unix maker's as stored, any
// other's from the DOS bits under the umask, unless the Unix mode it stored
// agrees with them, as PKZip for Unix writes one; filtattr() then drops the
// special bits. A symlink is one by its mode, from a maker known to make them.
const UNIX_HOSTS = new Set([2, 3, 5, 12, 13, 16, 17, 30])
const SYMLINK_HOSTS = new Set([2, 3, 5, 16, 30])
const MODE_EXTRAS = new Set([0x756e, 0x000c]) // ASI Unix and PKWARE VMS, read where the attributes hold no mode
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const DOS_READONLY = 1
const DOS_DIRECTORY = 0x10

function unzipAttributes({ system, attributes, extra, storedName }, at) {
  const host = Math.min(system, 31)
  if (host === 1 || host === 18) throw new DeptreeError('made on Amiga or THEOS, whose attributes unzip reads by that system', at)
  let unix = 0
  if (UNIX_HOSTS.has(host)) {
    unix = attributes >>> 16
    if (unix === 0 && extra.some(({ id }) => MODE_EXTRAS.has(id))) throw new DeptreeError('attributes with no mode, and an extra field unzip reads one from', at)
    return { mode: unix, symlink: (unix & S_IFMT) === S_IFLNK && SYMLINK_HOSTS.has(host) }
  }
  if (host === 0) unix = attributes >>> 16
  const dos = ((attributes & DOS_READONLY) === 0 ? 2 : 0) | ((attributes & DOS_DIRECTORY) !== 0 || storedName.endsWith('/') ? 1 : 0)
  if ((unix & 0o700) === (0o400 | (dos << 6))) return { mode: unix, symlink: (unix & S_IFMT) === S_IFLNK && host === 0 }
  return { mode: (0o444 | (dos << 6) | (dos << 3) | dos) & ~UMASK, symlink: false }
}

// What unzip stops to ask about, which fails `pod install` with nothing on
// stdin, and what its mapname() writes otherwise than the reader reads it.
const NON_ASCII = /[^\u0020-\u007E]/u
const VMS_VERSION = /;\d*$/u
const PKZIP_VERSION = 45
const VMS = 2

function checkEntry({ version, storedName, type }, at) {
  const needed = version & 0xff
  if (needed > PKZIP_VERSION) throw new DeptreeError(`needs PKZIP ${(needed / 10).toFixed(1)} to extract, past the 4.5 an unzip built without bzip2 takes`, at)
  if (version >> 8 === VMS) throw new DeptreeError('marked as stored in VMS format, which unzip asks before extracting', at)
  if (NON_ASCII.test(storedName)) throw new DeptreeError('a name with a character outside ASCII, which unzip writes by the machine\'s locale and its own build', at)
  if (type === 'directory') return
  const last = storedName.split('/').at(-1)
  if (last === '.') throw new DeptreeError('a name ending in a `.` segment, which unzip writes as `_`', at)
  if (VMS_VERSION.test(last)) throw new DeptreeError('a name ending in `;` and digits, which unzip takes for a VMS version and drops', at)
}

// Each entry as unzip writes it out, in the central directory's order; a
// directory entry's mode counts only where unzip makes the directory for it.
async function unzipped(bytes, where) {
  let entries
  try {
    entries = await unzip(bytes, { limit: MAX_BYTES })
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its archive cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  if (entries.length === 0) throw new DeptreeError('an empty archive, which unzip warns of, and CocoaPods fails on the warning', where)
  const dirs = new Set()
  const files = new Map()
  const links = new Map()
  const made = new Set()
  for (const entry of entries) {
    const { name, type } = entry
    if (name === '.') continue
    const at = `${where}: ${quote(entry.storedName)}`
    checkEntry(entry, at)
    const segments = name.split('/')
    if (segments.some(isGit)) throw gitRefusal(at)
    if (files.has(name) || links.has(name)) throw new DeptreeError('a name again, which unzip asks whether to replace', at)
    const { mode, symlink } = unzipAttributes(entry, at)
    if (symlink !== (type === 'symlink')) throw new DeptreeError('a symlink by the attributes of a maker that is not Unix, which unzip makes a link of', at)
    const perms = mode & 0o777
    for (let i = 1; i < segments.length; i++) made.add(segments.slice(0, i).join('/'))
    if (type === 'directory') {
      if (!made.has(name)) {
        if ((perms & 0o700) !== 0o700) throw dirRefusal(perms, at)
        made.add(name)
      }
      dirs.add(name)
    } else if (type === 'symlink') {
      links.set(name, entry.linkname)
    } else {
      if ((perms & 0o400) === 0) throw fileRefusal(perms, at)
      files.set(name, { data: entry.data, mode: perms })
    }
  }
  return { dirs, files, links }
}

// RemoteFile#extract_with_type's flattening: where the directory holds one
// thing beside the download, and that is a directory, its contents moved
// up, by a move of it to its name and `.tmp` first. A link there, which
// Pathname#directory? would follow, is refused, and so is a name the moves
// would meet: a name ending in `.`, which Pathname#sub_ext reads otherwise
// than it ends, or something in it of the name it is moved to.
function flattened(contents, where) {
  const tops = topsOf(contents)
  if (tops.size !== 1) return contents
  const [top] = tops
  if (contents.files.has(top)) return contents
  const at = `${where}: ${quote(top)}`
  if (contents.links.has(top)) throw new DeptreeError('the one thing in the archive is a link, which flattening it would follow', at)
  if (top.endsWith('.')) throw new DeptreeError('the one directory in the archive has a name ending in `.`, which flattening it reads otherwise', at)
  const strip = (path) => path.slice(top.length + 1)
  const inside = (path) => path.startsWith(`${top}/`)
  const stripped = (map) => new Map([...map].map(([path, value]) => [strip(path), value]))
  const moved = { dirs: new Set([...contents.dirs].filter(inside).map(strip)), files: stripped(contents.files), links: stripped(contents.links) }
  if (topsOf(moved).has(`${top}.tmp`)) throw new DeptreeError(`the one directory in the archive holds ${quote(`${top}.tmp`)}, the name it is moved to while it is flattened`, at)
  return moved
}

// `source` is sourceOf's of :http; the contents are as writeFiles takes them.
export async function archiveOf(bytes, source, where) {
  const contents = source.archive === 'zip' ? await unzipped(bytes, where) : await untarred(bytes, where)
  if (topsOf(contents).has(source.file)) throw new DeptreeError(`the archive holds ${quote(source.file)}, the name RemoteFile downloads it under where it extracts it`, where)
  return source.flatten ? flattened(contents, where) : contents
}
