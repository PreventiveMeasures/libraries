// An archive by :http as cocoapods-downloader's RemoteFile leaves it: saved
// as `file.<type>` in a directory, extracted there by `tar xf`, as GNU tar
// and bsdtar extract one for a user other than root under a umask of 0o022,
// then flattened where that is asked and the archive holds one directory,
// and the download removed.

import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { DeptreeError, quote } from '../error.js'
import { isGit } from '../soldeer/zip.js'
import { MAX_BYTES } from '../tarball.js'

const startsWith = (bytes, magic) => magic.every((byte, i) => bytes[i] === byte)
const GZIP = [0x1f, 0x8b]
// What `tar xf` decompresses by its magic too, and is not read here.
const OTHERS = [
  ['bzip2', [0x42, 0x5a, 0x68]], ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ['compress', [0x1f, 0x9d]], ['lzip', [0x4c, 0x5a, 0x49, 0x50]], ['lzma', [0x5d, 0x00, 0x00]],
]

// The setuid, setgid and sticky bits, which tar sets or drops by who runs
// it and where.
const SPECIAL = 0o7000
const UMASK = 0o022

// The names at the archive's root, a directory's that only paths under it
// name among them.
const topsOf = ({ dirs, files, links }) => new Set([...dirs, ...files.keys(), ...links.keys()].map((path) => path.split('/')[0]))

async function tarOf(bytes, where) {
  if (startsWith(bytes, GZIP)) {
    try {
      return await decompress(bytes, 'gzip', { limit: MAX_BYTES })
    } catch (error) {
      if (error instanceof ArchiveError) throw new DeptreeError(`its archive cannot be read: ${error.message}`, where, { cause: error })
      throw error
    }
  }
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
    if (segments.some(isGit)) throw new DeptreeError('a path with a .git in it, which CocoaPods 1.16 leaves out of its cache and those before keep', at)
    if (segments.some((segment) => segment.startsWith('._'))) throw new DeptreeError('a name starting with `._`, which bsdtar on macOS reads as the extended attributes of another', at)
    const mode = type === 'hardlink' ? undefined : entry.mode
    if (mode !== undefined && type !== 'symlink' && (mode & SPECIAL) !== 0) throw new DeptreeError(`a mode of ${mode.toString(8)}, with a bit tar sets or drops by who extracts it`, at)
    if (type === 'directory') {
      if ((mode & 0o700) !== 0o700) throw new DeptreeError(`a directory of mode ${mode.toString(8)}, which its owner cannot list and write in, as CocoaPods' cleaner has to`, at)
      dirs.add(name)
    } else if (type === 'file' || type === 'contiguous-file') {
      if ((mode & 0o400) === 0) throw new DeptreeError(`a file of mode ${mode.toString(8)}, which its owner cannot read, as CocoaPods' copy has to`, at)
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
  const moved = { dirs: new Set([...contents.dirs].filter(inside).map(strip)), files: new Map(), links: new Map() }
  for (const [path, file] of contents.files) moved.files.set(strip(path), file)
  for (const [path, target] of contents.links) moved.links.set(strip(path), target)
  if (topsOf(moved).has(`${top}.tmp`)) throw new DeptreeError(`the one directory in the archive holds ${quote(`${top}.tmp`)}, the name it is moved to while it is flattened`, at)
  return moved
}

// `source` is sourceOf's of :http. The contents are as writeFiles takes
// them, as a checkout's are.
export async function archiveOf(bytes, source, where) {
  let entries
  try {
    entries = unpack(await tarOf(bytes, where), { trailingGlobal: true })
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its archive cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  const contents = entriesOf(entries, where)
  if (topsOf(contents).has(source.file)) throw new DeptreeError(`the archive holds ${quote(source.file)}, the name RemoteFile downloads it under where it extracts it`, where)
  return source.flatten ? flattened(contents, where) : contents
}
