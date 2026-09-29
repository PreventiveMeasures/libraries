// A registry package's files, from its tarball: fetched through
// @preventive/upstream, which reads a cache of its own and npm's before
// the registry and holds what it gets to the integrity it is given, then
// held to that integrity again here, since it is the lockfile's; gunzipped
// and unpacked by @preventive/archive, with every rule of a name that
// holds; and read into files the way pnpm reads them out of a tarball
// (@pnpm/store.cafs): the first segment of each name dropped, whatever it
// is, only files kept, as ones not executable or executable by anyone.
//
// pnpm passes over what it does not keep, and takes a later file under a
// name over an earlier one; here a link of either kind or a device is
// refused, and so is a name that comes out twice as two different files.
// A tarball's package.json, if it has one, is held to the name and
// version the lockfile gives it, as pnpm holds a store's.

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { normalize } from '@preventive/vfs/path.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from './error.js'
import { matchesIntegrity } from './hash.js'

// What a tarball may unpack to, as upstream bounds what it downloads.
const MAX_BYTES = 512 * 1024 * 1024
const REGISTRY = 'https://registry.npmjs.org/'

// The registry's own URL for a version's tarball, as npm and pnpm spell it.
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`

const isGzip = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08

// pnpm's name for an entry: past the first `/` of the name as stored,
// folded where it has a `./` in it, a `//` made one.
function nameOf(stored) {
  const slash = stored.indexOf('/')
  let name = slash === -1 ? stored : stored.slice(slash + 1)
  if (name.includes('./')) name = normalize(`/${name}`).slice(1)
  return name.replaceAll('//', '/')
}

const sameFile = (a, b) => a.mode === b.mode && a.data.length === b.data.length && a.data.every((byte, i) => byte === b.data[i])

// A Map of each file's path in the package to its bytes and mode.
export function filesOf(entries, where) {
  const files = new Map()
  for (const entry of entries) {
    if (entry.type === 'directory' || entry.type === 'symlink') continue
    if (entry.type !== 'file') throw new DeptreeError(`${quote(entry.name)} is a ${entry.type}, which is not supported`, where)
    const name = nameOf(entry.storedName)
    if (name === '' || name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new DeptreeError(`${quote(entry.storedName)} names no file in the package`, where)
    }
    const file = { data: entry.data, mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755 }
    const earlier = files.get(name)
    if (earlier !== undefined && !sameFile(earlier, file)) throw new DeptreeError(`${quote(name)} is in the tarball twice`, where)
    files.set(name, file)
  }
  return files
}

const decoder = new TextDecoder('utf-8', { fatal: true })

function checkManifest(files, pkg, where) {
  const file = files.get('package.json')
  if (file === undefined) return
  let manifest
  try {
    manifest = JSON.parse(decoder.decode(file.data))
  } catch {
    throw new DeptreeError('package.json is not JSON', where)
  }
  const { name, version } = manifest ?? {}
  const sameName = typeof name === 'string' && name.toLowerCase() === pkg.name.toLowerCase()
  const sameVersion = version === pkg.version || (typeof version === 'string' && valid(version, { loose: true }) === pkg.version)
  if (!sameName || !sameVersion) throw new DeptreeError(`package.json is for ${quote(`${name}@${version}`)}`, where)
}

// The files of a snapshot's package, which has to be from the registry.
export async function fetchFiles(pkg, where) {
  const { integrity } = pkg.resolution
  const bytes = await getTarball(pkg.name, pkg.version, { tarball: tarballUrl(pkg.name, pkg.version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  const tar = isGzip(bytes) ? await decompress(bytes, 'gzip', { limit: MAX_BYTES }) : bytes
  const files = filesOf(unpack(tar), where)
  checkManifest(files, pkg, where)
  return files
}
