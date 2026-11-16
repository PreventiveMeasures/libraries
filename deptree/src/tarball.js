// A registry tarball through @preventive/upstream, its integrity checked again here as the lockfile's,
// and where asked for its version's document, for where the package comes from or for its size

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getMeta, getTarball } from '@preventive/upstream/npm.js'
import { settled } from './concurrent.js'
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

// A name and version the URL holds as they are: unescaped ASCII, no part `.` or `..`, nothing that ends
// the path. The lockfile reader holds both to more; the URL fetched is held to this whatever got here.
const NAME = /^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/u
const VERSION = /^[\dA-Za-z][\dA-Za-z.+-]*$/u

function checkId(name, version, where) {
  if (!NAME.test(name) || !VERSION.test(version)) throw new DeptreeError(`${quote(`${name}@${version}`)} is no package the registry's URL names as it is`, where)
}

// The registry's own tarball, by its sha512 alone, as fetchTarball takes it;
// where `unpinned`, with none where the lockfile records none, for
// fetchTarball to take the registry's.
export function ownTarball(url, name, version, integrity, where, unpinned = false) {
  checkId(name, version, where)
  const expected = tarballUrl(name, version)
  if (url !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${version}, ${expected}, is supported`, where)
  const sha512 = integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined && !(unpinned && integrity === undefined)) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
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

// What a version document says of where a package comes from, each
// undefined where it says nothing: `commit` is its gitHead.
const aboutOf = ({ gitHead, repository, homepage, bugs }) => ({ commit: gitHead, repository, homepage, bugs })
export const NO_ABOUT = Object.freeze(aboutOf({}))

// What a tree fetches from the registry: `sizeEstimateOnly` the documents alone (fetchSize), `lazy` a
// tarball as its package is unpacked. The two are refused together, and each with `into`, a Vfs to mount
// the files into.
export function fetchingOf({ metadata = true, cache, sizeEstimateOnly = false, lazy = false }, into) {
  if (typeof metadata !== 'boolean') throw new TypeError('metadata must be a boolean, or left out')
  if (cache !== undefined && cache !== false && (typeof cache?.read !== 'function' || typeof cache?.write !== 'function')) {
    throw new TypeError('cache must be false, or a store with read and write, or left out')
  }
  if (typeof sizeEstimateOnly !== 'boolean') throw new TypeError('sizeEstimateOnly must be a boolean, or left out')
  if (typeof lazy !== 'boolean') throw new TypeError('lazy must be a boolean, or left out')
  if (lazy && sizeEstimateOnly) throw new TypeError('lazy is not taken with sizeEstimateOnly, which fetches no tarball to unpack')
  if (sizeEstimateOnly && into !== undefined) throw new TypeError('vfs is not taken with sizeEstimateOnly, whose tree has no files to mount')
  if (lazy && into !== undefined) throw new TypeError('vfs is not taken with lazy, whose tree is unpacked a package at a time')
  return { metadata, cache, sizeEstimateOnly, lazy }
}

const SHA512 = /^sha512-[\d+/A-Za-z]{86}==$/u

// Without a `given` integrity, as ownTarball lets one through unpinned, the version document's is taken,
// and `about` is what it says. Else with `metadata` the document is asked for beside the tarball, held by
// getMeta to the dist the tarball is fetched by, so nothing is hashed again.
export async function fetchTarball(name, version, given, where, { metadata, cache }) {
  checkId(name, version, where)
  const meta = given === undefined ? await getMeta(name, version, { cache }) : undefined
  const integrity = given ?? meta.dist.integrity
  if (!SHA512.test(integrity)) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  const dist = { tarball: tarballUrl(name, version), integrity }
  const about = meta === undefined ? (metadata ? getMeta(name, version, { dist, cache }).then(aboutOf) : NO_ABOUT) : aboutOf(meta)
  const [bytes, said] = await settled([getTarball(name, version, dist, { cache }), about])
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const tar = await decompress(bytes, 'gzip', { limit: MAX_BYTES })
  return { bytes, tar, entries: unpack(tar), inflated: tar.length, integrity, about: said }
}

// The version's document alone, asked for as fetchTarball asks for it: `size` its unpackedSize, the
// bytes of the files as the registry counted them, or undefined
export async function fetchSize(name, version, integrity, where, { cache }) {
  checkId(name, version, where)
  if (!SHA512.test(integrity)) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  const meta = await getMeta(name, version, { dist: { tarball: tarballUrl(name, version), integrity }, cache })
  return { size: meta.unpackedSize, about: aboutOf(meta) }
}
