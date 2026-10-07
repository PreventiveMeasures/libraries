// A .crate as `cargo vendor` unpacks it into vendor/, cargo 1.94 to 1.99:
// registry/mod.rs's unpack, through vendor.rs's vendor_this; what the archive
// reader takes and cargo would read otherwise is refused. As a 0o022 umask
// leaves them, each directory is 0o755 unless its own entry gives a mode, and
// each file its mode within 0o777, both without group and other write bits.

import { crc32 } from '@exodus/bytes/crc.js'
import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { bytesSha256Hex } from '../hash.js'
import { own } from '../manifest.js'

// Cargo's bound on what a .crate unpacks to: 512 MiB, or twenty times the
// .crate where that is more.
const unpackLimit = (bytes) => Math.max(512 * 1024 * 1024, bytes.length * 20)
const [FTEXT, FEXTRA, FNAME, FCOMMENT] = [0x01, 0x04, 0x08, 0x10]

// Where the gzip member's deflate data starts, past its header: a header CRC
// or a reserved flag, which a reader may take or not, is refused.
function deflateStart(bytes, where) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the .crate is not gzipped', where)
  const flags = bytes[3]
  if (flags & ~(FTEXT | FEXTRA | FNAME | FCOMMENT)) throw new DeptreeError('a gzip header with a header CRC or a reserved flag is not supported', where)
  let at = 10
  if (flags & FEXTRA) at += 2 + (bytes[at] | (bytes[at + 1] << 8))
  for (const flag of [FNAME, FCOMMENT]) {
    if (!(flags & flag)) continue
    const end = bytes.indexOf(0, at)
    at = end === -1 ? bytes.length : end + 1
  }
  if (at > bytes.length - 8) throw new DeptreeError('the .crate\'s gzip header runs past its end', where)
  return at
}

// flate2's GzDecoder, which cargo reads a .crate through, reads its first
// gzip member alone, where the platform's stream reads on into any after it;
// so the first has to be all of it. Its deflate data has to end where its
// eight-byte trailer starts, which deflate-raw holds it to, refusing what
// follows; and the trailer has to be the data's CRC-32 and length, as flate2
// checks them.
async function gunzip(bytes, where) {
  const start = deflateStart(bytes, where)
  const limit = unpackLimit(bytes)
  let tar
  try {
    tar = await decompress(bytes.subarray(start, bytes.length - 8), 'deflate-raw', { limit })
  } catch (error) {
    if (!(error instanceof CompressionError)) throw error
    throw new DeptreeError(error.limited ? `the .crate unpacks to more than ${limit} bytes, which cargo refuses` : 'the .crate is not one gzip member, which cargo reads the first of alone', where, { cause: error })
  }
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8)
  if (trailer.getUint32(0, true) !== crc32(tar) || trailer.getUint32(4, true) !== tar.length >>> 0) throw new DeptreeError('the .crate\'s gzip trailer does not match its data', where)
  return tar
}

function entriesOf(tar, where) {
  try {
    return unpack(tar)
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`the .crate cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
}

// vendor_this: a `.git` anywhere on the way, a .gitattributes or .gitignore
// by name, .cargo-ok at the root; each is passed over before its type is
// looked at, unlike unpack's own .cargo-ok anywhere, after it.
const vendored = (segments, last) => !segments.includes('.git') && last !== '.gitattributes' && last !== '.gitignore' && segments.join('/') !== '.cargo-ok'

const modeOf = (entry) => entry.mode & 0o777 & ~0o022
const unsupported = (entry, why, here) => new DeptreeError(`mode ${entry.mode.toString(8)}, which keeps cargo from ${why} as any user but root, is not supported`, here)

// As any user but root, cargo reads back no file without its owner's read
// bit; lists nothing in a directory without its owner's read and search
// bits, leaving what is in it out of .cargo-checksum.json; and writes
// nothing into one without its write bit once its entry has set it, `after`.
// A directory nothing is in may have any mode. The package's always has
// something written into it last, its .cargo-checksum.json.
function fileMode(entry, here) {
  const mode = modeOf(entry)
  if (!(mode & 0o400)) throw unsupported(entry, 'reading it back to checksum it', here)
  return mode
}
function dirMode({ entry, here, after }, content) {
  const mode = modeOf(entry)
  if (content && (mode & 0o500) !== 0o500) throw unsupported(entry, 'listing what is in it', here)
  if (after && !(mode & 0o200)) throw unsupported(entry, 'writing into it what comes after it', here)
  return mode
}

// The directory `<name>-<version>` every entry has to be in, as Rust's
// strip_prefix reads a path: by its components, so `./` or `/` before it
// is not it.
function segmentsOf(entry, prefix, here) {
  const [first, ...rest] = entry.name.split('/')
  if (entry.storedName.startsWith('/') || entry.storedName.startsWith('./') || first !== prefix) throw new DeptreeError(`not under ${quote(prefix)}, which cargo refuses`, here)
  // tar 0.4.44, in cargo 1.94.0, takes the header's size over a pax one.
  if (entry.pax.has('size')) throw new DeptreeError('a pax size, which cargo 1.94.0 reads otherwise, is not supported', here)
  return rest
}

// `root` is the mode of the package's directory; `dirs` maps each directory
// under it to its mode, 0o755 where no entry of its own gives one.
function vendorEntries(entries, prefix, where) {
  const dirs = new Map()
  const files = new Map()
  // Each directory an entry of its own gives a mode, the package's as ''.
  const given = new Map()
  for (const entry of entries) {
    const here = `${where}: ${quote(entry.storedName)}`
    const segments = segmentsOf(entry, prefix, here)
    const last = segments.at(-1)
    if (!vendored(segments, last)) continue
    if (entry.type !== 'file' && entry.type !== 'directory') throw new DeptreeError(`a ${entry.type}, which cargo refuses`, here)
    if (last === '.cargo-ok') continue
    if (segments.length === 0 && entry.type !== 'directory') throw new DeptreeError('the package\'s directory is not a directory', here)
    if (segments[0] === '.cargo-checksum.json') throw new DeptreeError('a .cargo-checksum.json of its own, which cargo vendor lists and then writes over, so that cargo cannot build from it', here)
    // Each directory it is written into, the package's first.
    let dir = ''
    for (let i = 0; i < segments.length; i++) {
      if (given.has(dir)) given.get(dir).after = true
      if (i > 0 && !dirs.has(dir)) dirs.set(dir, 0o755)
      dir = i === 0 ? segments[0] : `${dir}/${segments[i]}`
    }
    const path = segments.join('/')
    if (entry.type === 'file') files.set(path, { data: entry.data, mode: fileMode(entry, here) })
    else if (!given.has(path)) given.set(path, { entry, here, after: path === '' })
  }
  // A directory under the package's has something in it where an entry made it.
  let root = 0o755
  for (const [path, dir] of given) {
    if (path === '') root = dirMode(dir, true)
    else dirs.set(path, dirMode(dir, dirs.has(path)))
  }
  return { root, dirs, files }
}

const COMMENT = 'This file only protects against accidental modifications. It is not a security mechanism and does not protect against malicious changes.'

// vendor.rs's, as serde_json writes it: compact, each map's keys in UTF-8
// byte order, `$comment` from cargo 1.97 on.
async function checksumFile(files, checksum, comment) {
  const paths = [...files.keys()].sort(compareNames)
  const sums = await Promise.all(paths.map((path) => bytesSha256Hex(files.get(path).data)))
  const listed = paths.map((path, i) => `${JSON.stringify(path)}:"${sums[i]}"`).join(',')
  return `{${comment ? `"$comment":${JSON.stringify(COMMENT)},` : ''}"files":{${listed}},"package":${JSON.stringify(checksum)}}`
}

// A full commit id, as git writes one: 40 lowercase hex digits, or 64 in a
// repository of SHA-256 objects.
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/u

// The commit .cargo_vcs_info.json names, which `cargo package` writes where
// it packs from a git checkout: none where it found the checkout dirty, as
// the files are then not that commit's, nor where it names anything but a
// full id. Cargo reads none of it, so one that is not JSON names none, and
// is vendored all the same.
function vcsCommitOf(file) {
  if (file === undefined) return undefined
  try {
    const git = own(JSON.parse(utf8toString(file.data)), 'git')
    if (![undefined, false].includes(own(git, 'dirty'))) return undefined
    const sha1 = own(git, 'sha1')
    return typeof sha1 === 'string' && COMMIT.test(sha1) ? sha1 : undefined
  } catch {
    return undefined
  }
}

// What vendor/<directory> holds of a package, `.cargo-checksum.json` among
// its files. getCrate has held the .crate to its checksum; it is held to it
// again where it is unpacked.
export async function vendorCrate(bytes, { name, version, checksum }, comment, where) {
  if (await bytesSha256Hex(bytes) !== checksum) throw new DeptreeError(`its .crate's sha256 is not ${checksum}`, where)
  const { root, dirs, files } = vendorEntries(entriesOf(await gunzip(bytes, where), where), `${name}-${version}`, where)
  const commit = vcsCommitOf(files.get('.cargo_vcs_info.json'))
  const text = await checksumFile(files, checksum, comment)
  files.set('.cargo-checksum.json', { data: utf8fromString(text), mode: 0o644 })
  return { root, dirs, files, checksumText: text, commit }
}
