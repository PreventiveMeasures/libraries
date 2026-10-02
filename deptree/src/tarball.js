// A registry tarball, fetched through @preventive/upstream, which checks the
// integrity it is given, and checked again here, as that is the lockfile's.

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { DeptreeError, quote } from './error.js'
import { matchesIntegrity } from './hash.js'

// What a tarball may unpack to, as upstream bounds what it downloads.
const MAX_BYTES = 512 * 1024 * 1024
export const REGISTRY = 'https://registry.npmjs.org/'

// The registry's own URL for a version's tarball, as npm and pnpm spell it.
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`

// The registry's own tarball, by its sha512 alone, as fetchTarball takes it.
export function ownTarball(url, name, version, integrity, where) {
  const expected = tarballUrl(name, version)
  if (url !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${version}, ${expected}, is supported`, where)
  const sha512 = integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version, integrity: sha512 }
}

// yarn's mirror of npm's registry serves the same tarballs at the same paths.
const YARNPKG = 'https://registry.yarnpkg.com/'
export const fromMirror = (url) => (url.startsWith(YARNPKG) ? `${REGISTRY}${url.slice(YARNPKG.length)}` : url)

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
export const sameFile = (a, b) => a.mode === b.mode && sameBytes(a.data, b.data)

// Adds to `dirs` each one `files` are in, refusing one that is a file too.
export function withDirs(files, where, dirs = new Set()) {
  for (const path of files.keys()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  for (const dir of dirs) if (files.has(dir)) throw new DeptreeError(`${quote(dir)} is both a file and a directory in the tarball`, where)
  return { files, dirs }
}

export async function fetchTarball(name, version, integrity, where) {
  const bytes = await getTarball(name, version, { tarball: tarballUrl(name, version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const tar = await decompress(bytes, 'gzip', { limit: MAX_BYTES })
  return { bytes, entries: unpack(tar), inflated: tar.length }
}
