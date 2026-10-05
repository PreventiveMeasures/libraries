// A .crate as `cargo vendor` unpacks it into vendor/, cargo 1.94 to 1.99:
// registry/mod.rs's unpack, through vendor.rs's vendor_this; what the archive
// reader takes and cargo would read otherwise is refused. As a 0o022 umask
// leaves them, each directory is 0o755 unless its own entry gives a mode, and
// each file its mode within 0o777, both without group and other write bits.

import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { bytesSha256Hex, crc32 } from '../hash.js'

// As in ../tarball.js; cargo's own bound is 512 MiB, or twenty times the
// .crate where that is more.
const MAX_BYTES = 512 * 1024 * 1024
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
  let tar
  try {
    tar = await decompress(bytes.subarray(start, bytes.length - 8), 'deflate-raw', { limit: MAX_BYTES })
  } catch (error) {
    if (!(error instanceof CompressionError)) throw error
    throw new DeptreeError(error.limited ? `the .crate unpacks to more than ${MAX_BYTES} bytes` : 'the .crate is not one gzip member, which cargo reads the first of alone', where, { cause: error })
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

// A directory cargo could not write into, or a file it could not read back to
// checksum, as any user but root.
function modeOf(entry, here) {
  const mode = entry.mode & 0o777 & ~0o022
  const needed = entry.type === 'directory' ? 0o700 : 0o400
  if ((mode & needed) !== needed) throw new DeptreeError(`mode ${entry.mode.toString(8)}, which cargo fails on as any user but root, is not supported`, here)
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

// `root` is the mode the package's directory has where an entry gives one;
// `dirs` maps each directory under it to its mode.
function vendorEntries(entries, prefix, where) {
  const dirs = new Map()
  const files = new Map()
  let root = 0o755
  for (const entry of entries) {
    const here = `${where}: ${quote(entry.storedName)}`
    const segments = segmentsOf(entry, prefix, here)
    const last = segments.at(-1)
    if (!vendored(segments, last)) continue
    if (entry.type !== 'file' && entry.type !== 'directory') throw new DeptreeError(`a ${entry.type}, which cargo refuses`, here)
    if (last === '.cargo-ok') continue
    if (segments.length === 0) {
      if (entry.type !== 'directory') throw new DeptreeError('the package\'s directory is not a directory', here)
      root = modeOf(entry, here)
      continue
    }
    if (segments[0] === '.cargo-checksum.json') throw new DeptreeError('a .cargo-checksum.json of its own, which cargo vendor lists and then writes over, so that cargo cannot build from it', here)
    const path = segments.join('/')
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/')
      if (!dirs.has(dir)) dirs.set(dir, 0o755)
    }
    if (entry.type === 'directory') dirs.set(path, modeOf(entry, here))
    else files.set(path, { data: entry.data, mode: modeOf(entry, here) })
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

// What vendor/<directory> holds of a package, `.cargo-checksum.json` among
// its files. getCrate has held the .crate to its checksum; it is held to it
// again where it is unpacked.
export async function vendorCrate(bytes, { name, version, checksum }, comment, where) {
  if (await bytesSha256Hex(bytes) !== checksum) throw new DeptreeError(`its .crate's sha256 is not ${checksum}`, where)
  const { root, dirs, files } = vendorEntries(entriesOf(await gunzip(bytes, where), where), `${name}-${version}`, where)
  const text = await checksumFile(files, checksum, comment)
  files.set('.cargo-checksum.json', { data: new TextEncoder().encode(text), mode: 0o644 })
  return { root, dirs, files, checksumText: text }
}
