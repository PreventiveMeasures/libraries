// A registry tarball, fetched through @preventive/upstream, which checks the
// integrity it is given, and checked again here, as that is the lockfile's.

import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { DeptreeError, quote } from './error.js'
import { matchesIntegrity } from './hash.js'
import { fold } from './mount.js'
import { decodeUtf8 } from './project.js'

// What a tarball or a zip may unpack to, as upstream bounds what it
// downloads: the archive reader makes room for what entries declare.
export const MAX_BYTES = 512 * 1024 * 1024
export const REGISTRY = 'https://registry.npmjs.org/'

// The registry's own URL for a version's tarball, as npm and pnpm spell it.
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`

// A name and a version that URL holds as they are: ASCII a URL takes
// unescaped, no part of the name `.` or `..`, and nothing that would end the
// path. The lockfile reader holds both to more; the URL fetched is held to
// this whatever reached here.
const NAME = /^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/u
const VERSION = /^[\dA-Za-z][\dA-Za-z.+-]*$/u

function checkId(name, version, where) {
  if (!NAME.test(name) || !VERSION.test(version)) throw new DeptreeError(`${quote(`${name}@${version}`)} is no package the registry's URL names as it is`, where)
}

// The registry's own tarball, by its sha512 alone, as fetchTarball takes it.
export function ownTarball(url, name, version, integrity, where) {
  checkId(name, version, where)
  const expected = tarballUrl(name, version)
  if (url !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${version}, ${expected}, is supported`, where)
  const sha512 = integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version, integrity: sha512 }
}

// yarn's mirror of npm's registry serves the same tarballs at the same paths.
const YARNPKG = 'https://registry.yarnpkg.com/'
export const fromMirror = (url) => (url.startsWith(YARNPKG) ? `${REGISTRY}${url.slice(YARNPKG.length)}` : url)

// The name of a package's own node_modules, where npm and yarn install its
// dependencies, in any case: macOS takes `Node_Modules` for it.
export const isModules = (name) => fold(name) === 'node_modules'

export const sameFile = (a, b) => a.mode === b.mode && a.data.length === b.data.length && a.data.every((byte, i) => byte === b.data[i])

// Where a file's first line is a `#!` one ending in a CRLF within its first
// 2048 bytes, as bin-links' fixBin tells it, the index of its LF; else -1.
export function crlfShebang(data) {
  if (data[0] !== 0x23 || data[1] !== 0x21) return -1
  const newline = data.subarray(0, 2048).indexOf(0x0a)
  return newline >= 4 && data[newline - 1] === 0x0d ? newline : -1
}

// `data` less such a line's CR; the file is rewritten as UTF-8, else refused with `detail`.
export function fixShebang(data, detail, where) {
  const newline = crlfShebang(data)
  if (newline === -1) return data
  decodeUtf8(data, detail, where)
  const copy = new Uint8Array(data.length - 1)
  copy.set(data.subarray(0, newline - 1))
  copy.set(data.subarray(newline), newline - 1)
  return copy
}

// Adds to `dirs` each one `files` are in, refusing one that is a file too.
export function withDirs(files, where, dirs = new Set()) {
  for (const path of files.keys()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  for (const dir of dirs) if (files.has(dir)) throw new DeptreeError(`${quote(dir)} is both a file and a directory in the tarball`, where)
  return { files, dirs }
}

// Old tarballs, as npm 1.0 packed them through the system's tar, may run on
// in zeros past their gzip stream, to a whole 10240-byte record. Node's
// zlib, which npm, pnpm and yarn unpack through, stops at a zero byte after
// the stream; the platform's stream refuses anything there, so the zeros are
// cut off. The stream's last four bytes are the length its last member
// inflates to, under 2^32 as MAX_BYTES is, so it ends within three bytes
// past the last that is not zero; or, where that member is empty, as zlib
// writes one, `03 00` and eight zeros, within nine. It ends at the one place
// it decompresses whole. Each place tried inflates it all again, which only
// a padded tarball pays for.
async function gunzip(bytes) {
  const inflate = (end) => decompress(bytes.subarray(0, end), 'gzip', { limit: MAX_BYTES })
  try {
    return await inflate(bytes.length)
  } catch (error) {
    if (!(error instanceof CompressionError) || error.limited || bytes.at(-1) !== 0) throw error
    const last = bytes.findLastIndex((byte) => byte !== 0)
    for (let end = last + 1; end <= Math.min(last + 10, bytes.length - 1); end++) {
      try {
        return await inflate(end)
      } catch {
        // Not where the stream ends: the next byte may be.
      }
    }
    throw error
  }
}

export async function fetchTarball(name, version, integrity, where) {
  checkId(name, version, where)
  if (!/^sha512-[\d+/A-Za-z]{86}==$/u.test(integrity)) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  const bytes = await getTarball(name, version, { tarball: tarballUrl(name, version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const tar = await gunzip(bytes)
  return { bytes, entries: unpack(tar), inflated: tar.length }
}
