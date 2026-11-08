// Archives made at random, as GitHub or a release might hold one, for
// RemoteFile to extract and the port to read alike: tars, most of them one
// directory, some of modes a user's tar keeps, drops or is refused here, with
// links and hard links, gzipped or not, whatever their type says; zips as
// Info-ZIP's zip writes one, of a Unix maker; and zips with every field as
// given, of the makers unzip reads attributes by, with the names it writes
// otherwise, the versions it refuses, repeats and all. Each flattened by
// default, or as :flatten says.
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { zip } from '@preventive/archive/zip.js'
import { archiveOf } from '../src/cocoapods/archive.js'
import { rawZip } from './registry.js'

export function random(seed) {
  let state = seed
  const next = (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % n
  }
  const pick = (items) => items[next(items.length)]
  return { next, pick, join: (items, length) => Array.from({ length }, () => pick(items)).join('') }
}

export const NAMES = ['a', 'A', 'Sources', 'sources', 'Source', 'Classes', 'Res', 'res.bundle', 'x.m', 'X.M', 'y.h', 'z.swift', 'img.png', 'README.md', 'readme', 'LICENSE', 'License.md', '.hidden', 'foo.', 'mod.modulemap', 'pre.pch', 'lib.a', 'F.framework', 'Tests', 'S', 'So', '._res']
export const DIRS = ['a', 'Sources', 'sources', 'Source', 'Classes', 'Res', 'res.bundle', 'Tests', 'S', 'F.framework', 'sub', '.hid', 'd.', '__MACOSX']
const TOPS = ['Pod-1.0', 'pod', 'v1.2.3', 'x.tmp', 'v1;2']
// Those refused here, a special bit or what the owner cannot read, list or
// write in, now and then.
const FILE_MODES = [0o644, 0o644, 0o644, 0o755, 0o444, 0o600, 0o664, 0o777, 0o700, 0o640]
const DIR_MODES = [0o755, 0o755, 0o755, 0o700, 0o775, 0o777]
const fileMode = (r) => (r.next(97) < 2 ? r.pick([0o4755, 0o200, 0o1644, 0o2644]) : r.pick(FILE_MODES))
const dirMode = (r) => (r.next(97) < 2 ? r.pick([0o555, 0o2755, 0o311]) : r.pick(DIR_MODES))
const LINK_TARGETS = ['x.m', 'README.md', 'nowhere', 'a']

// A tree at random, as entries for pack or zip: each path's kind in `kinds`,
// a directory's whether or not an entry names it; a hard link now and then
// where `hardlinks`, which a tar alone holds.
function treeOf(r, hardlinks) {
  const kinds = new Map()
  const entries = []
  const top = r.next(4) === 0 ? '' : r.pick(TOPS)
  const dirEntry = (path) => entries.push({ name: `${path}/`, type: 'directory', mode: dirMode(r) })
  if (top !== '') {
    kinds.set(top, 'directory')
    if (r.next(2) === 0) dirEntry(top)
  }
  const files = []
  for (let i = 1 + r.next(12); i > 0; i--) {
    const dirs = [...(top === '' ? [] : [top]), ...Array.from({ length: r.next(3) }, () => r.pick(DIRS))]
    const parents = dirs.map((_, k) => dirs.slice(0, k + 1).join('/'))
    const path = [...dirs, r.pick(NAMES)].join('/')
    if (kinds.has(path) || parents.some((dir) => kinds.has(dir) && kinds.get(dir) !== 'directory')) continue
    for (const dir of parents) {
      if (kinds.has(dir)) continue
      kinds.set(dir, 'directory')
      if (r.next(2) === 0) dirEntry(dir)
    }
    const kind = r.next(10)
    if (kind === 0) {
      kinds.set(path, 'directory')
      dirEntry(path)
    } else if (kind === 1) {
      kinds.set(path, 'symlink')
      entries.push({ name: path, type: 'symlink', linkname: r.pick(LINK_TARGETS) })
    } else if (kind === 2 && hardlinks && files.length > 0) {
      kinds.set(path, 'file')
      entries.push({ name: path, type: 'hardlink', linkname: r.pick(files) })
    } else {
      kinds.set(path, 'file')
      entries.push({ name: path, data: Buffer.from(path), mode: fileMode(r) })
      files.push(path)
    }
  }
  if (top !== '' && r.next(5) === 0) entries.push({ name: r.pick(['README', '.DS_Store', 'pax']), data: Buffer.from('beside') })
  return { top, kinds, entries }
}

const flattenOf = (r) => {
  const flatten = r.pick([undefined, undefined, true, false, null])
  return flatten === undefined ? {} : { flatten }
}
const base64 = (bytes) => Buffer.from(bytes).toString('base64')

export async function tarCaseOf(r) {
  const { entries } = treeOf(r, true)
  const type = r.pick(['tgz', 'tar', 'tgz', 'tbz'])
  const tar = pack(entries, { format: r.pick(['gnu', 'pax', 'ustar']) })
  const archive = r.next(3) === 0 ? tar : await compress(tar, 'gzip')
  return { archive: base64(archive), type, ...flattenOf(r) }
}

// As Info-ZIP's zip writes one: a Unix maker, each mode as given.
export async function zipCaseOf(r) {
  const { entries } = treeOf(r, false)
  const archive = await zip(entries, { method: r.pick(['deflate', 'store']) })
  return { archive: base64(archive), type: 'zip', ...flattenOf(r) }
}

// The makers unzip reads attributes by: MS-DOS, Unix, NTFS, VMS, BeOS, QDOS
// and one it does not know; Amiga and THEOS, refused here, now and then.
const SYSTEMS = [0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 11, 2, 16, 12, 99]
const systemOf = (r) => (r.next(97) < 2 ? 1 : r.next(97) < 2 ? 18 : r.pick(SYSTEMS))
const TYPE_BITS = { directory: 0o040000, symlink: 0o120000, file: 0o100000 }
const UT = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0])
const ASI = Buffer.concat([Buffer.from([0x6e, 0x75, 14, 0]), Buffer.alloc(14)])

// The external attributes, as a maker on `system` might write them: a Unix
// mode in the upper half, with the type bits or without, or none; the DOS
// bits in the lower, the directory bit for a directory mostly, read-only or
// archive now and then.
function attributesOf(r, system, type, mode) {
  const dos = type === 'directory' ? (r.next(97) < 7 ? 0x11 : r.pick([0x10, 0x10, 0x10, 0x10, 0])) : r.pick([0, 0, 0, 0, 1, 0x20, 0x21])
  const typed = TYPE_BITS[type] | mode
  let upper = r.next(101) < 2 ? 0 : r.pick([typed, typed, typed, typed, mode])
  if (system === 0) upper = r.pick([0, 0, 0, 0, typed, 0o100664, 0o100755, 0o100444, 0o120777, 0o120600, 0o040755])
  return upper * 0x10000 + dos
}

// A name as a maker might write it, and unzip otherwise than it is stored:
// `./` ahead, which both drop; `;` and digits, which unzip drops; a `.`
// segment, which it writes as `_`; one outside ASCII, by the locale.
const ODD_NAMES = ['x;1', 'y;', 'z;2a', './dot', 'sub/.', 'ü', 'a\u0001b', './sub/dot']

export function rawZipCaseOf(r) {
  const { top, kinds, entries: made } = treeOf(r, false)
  const entryOf = (entry) => {
    const type = entry.type ?? 'file'
    const system = systemOf(r)
    const mode = type === 'symlink' ? 0o777 : entry.mode
    const out = { name: entry.name, data: type === 'symlink' ? entry.linkname : entry.data, system, attributes: attributesOf(r, system, type, mode), deflate: r.next(3) === 0 }
    if (r.next(89) < 3) out.version = r.pick([10, 45, 46, 20 | (2 << 8), 20])
    if (r.next(83) < 4) out.extra = r.pick([UT, ASI, UT])
    return out
  }
  const entries = made.map(entryOf)
  // A directory entry after what is in it; an entry again; a name unzip
  // writes otherwise, first, ahead of anything else refused; the archive
  // root.
  if (entries.length > 1 && r.next(53) < 13) entries.push(entries.splice(r.next(entries.length), 1)[0])
  if (entries.length > 0 && r.next(61) < 4) entries.push({ ...r.pick(entries) })
  if (r.next(71) < 7) {
    const odd = `${top === '' ? '' : `${top}/`}${r.pick(ODD_NAMES)}`
    if (!kinds.has(odd)) entries.unshift(entryOf({ name: odd, data: Buffer.from(odd), mode: 0o644 }))
  }
  if (r.next(67) < 7) entries.unshift({ name: './', system: 3, attributes: 0o040755 * 0x10000 + 0x10 })
  return { archive: base64(rawZip(entries)), type: 'zip', ...flattenOf(r) }
}

export const sorted = (entries) => entries.map((entry) => JSON.stringify(entry)).sort()

// The port's extraction of a case, as the reference lists it, every
// directory on the way to a path among them; or what it refuses.
export async function portExtract({ archive, type, flatten }) {
  const source = { archive: type, file: `file.${type}`, flatten: flatten === undefined ? type !== 'zip' : flatten !== null && flatten !== false }
  const out = await archiveOf(Buffer.from(archive, 'base64'), source, 'pod')
  const dirs = new Set(out.dirs)
  for (const path of [...out.dirs, ...out.files.keys(), ...out.links.keys()]) {
    for (let at = path; at.includes('/');) dirs.add(at = at.slice(0, at.lastIndexOf('/')))
  }
  return [...[...dirs].map((dir) => [dir, 'directory']), ...[...out.files].map(([path, { mode }]) => [path, 'file', mode]), ...[...out.links].map(([path, target]) => [path, 'symlink', target])]
}
