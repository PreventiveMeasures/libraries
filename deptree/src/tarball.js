// A registry package's tarball, fetched through @preventive/upstream, which
// checks the integrity it is given; checked again here, since that
// integrity is the lockfile's; and unpacked by @preventive/archive. What
// each package manager makes of its entries is its own (pnpm/package.js,
// yarn1/package.js).

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { DeptreeError } from './error.js'
import { matchesIntegrity } from './hash.js'

// What a tarball may unpack to, as upstream bounds what it downloads.
const MAX_BYTES = 512 * 1024 * 1024
export const REGISTRY = 'https://registry.npmjs.org/'

// The registry's own URL for a version's tarball, as npm and pnpm spell it.
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
export const sameFile = (a, b) => a.mode === b.mode && sameBytes(a.data, b.data)

export async function fetchTarball(name, version, integrity, where) {
  const bytes = await getTarball(name, version, { tarball: tarballUrl(name, version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const tar = await decompress(bytes, 'gzip', { limit: MAX_BYTES })
  return { bytes, entries: unpack(tar), inflated: tar.length }
}
