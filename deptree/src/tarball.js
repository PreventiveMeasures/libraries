// A registry package's files, from its tarball: fetched through
// @preventive/upstream, which reads a cache of its own and npm's before
// the registry and holds what it gets to the integrity it is given, then
// held to that integrity again here, since it is the lockfile's; gunzipped
// and unpacked by @preventive/archive, with every rule of a name that
// holds; and read into files the way pnpm reads them out of a tarball
// (@pnpm/store.cafs): the first segment of each name dropped, whatever it
// is, only files kept, as ones not executable or executable by anyone.
//
// Here it is held to more than pnpm holds it to, to what npm packs: a
// gzipped tarball, every file under one directory, no link of either kind
// or device, which pnpm would pass over or refuse, and no name twice as
// two different files, of which pnpm would keep the later. It has to have
// a package.json, for exactly the name and version the lockfile says, and
// that package.json has to agree with what the lockfile recorded of the
// package's: its os, cpu and libc, whether it has bins, what it bundles.
// And every dependency it asks for, read through pnpm's read-package hook
// as pnpm reads it (hook.js), has to be among each of its snapshots', bundled
// or optional ones aside: a lockfile that leaves one out would leave the
// package to find it wherever it is hoisted, if anywhere. A registry whose
// metadata says other than its tarball does is caught at the same time.
//
// A package is fetched and read once however many snapshots it has, one
// for each set of peers it is resolved with.

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { normalize } from '@preventive/vfs/path.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { DeptreeError, quote } from './error.js'
import { matchesIntegrity } from './hash.js'

// What a tarball may unpack to, as upstream bounds what it downloads.
const MAX_BYTES = 512 * 1024 * 1024
export const REGISTRY = 'https://registry.npmjs.org/'

// The registry's own URL for a version's tarball, as npm and pnpm spell it.
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`

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
  const tops = new Set()
  for (const entry of entries) {
    if (entry.type === 'directory') continue
    if (entry.type !== 'file') throw new DeptreeError(`${quote(entry.name)} is a ${entry.type}, which is not supported`, where)
    tops.add(entry.storedName.slice(0, Math.max(entry.storedName.indexOf('/'), 0)))
    if (tops.size > 1) throw new DeptreeError('the tarball has files under more than one directory, or at its top', where)
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const names = (value) => Object.keys(value ?? {})

// Whether a package.json has bins, as the lockfile's hasBin records it.
const hasBin = (manifest) => Boolean((manifest.bin && (typeof manifest.bin === 'string' || Object.keys(manifest.bin).length > 0)) || manifest.directories?.bin)

function readManifest(files, pkg, where) {
  const file = files.get('package.json')
  if (file === undefined) throw new DeptreeError('the tarball has no package.json', where)
  let manifest
  try {
    manifest = JSON.parse(decoder.decode(file.data))
  } catch {
    throw new DeptreeError('package.json is not JSON', where)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('package.json is not an object', where)
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new DeptreeError(`package.json is for ${quote(`${manifest.name}@${manifest.version}`)}`, where)
  return manifest
}

// What the lockfile recorded of the package against the package.json.
function checkManifest(manifest, pkg, where) {
  for (const field of ['os', 'cpu', 'libc']) {
    if (!same(manifest[field], pkg[field])) throw new DeptreeError(`package.json's ${field} is not the lockfile's`, where)
  }
  if (hasBin(manifest) !== pkg.hasBin) throw new DeptreeError(`package.json ${pkg.hasBin ? 'has no bins, and the lockfile says it has' : 'has bins, and the lockfile says it has none'}`, where)
  if (!same(bundledOf(manifest), pkg.bundledDependencies)) throw new DeptreeError('package.json bundles other than the lockfile says', where)
}

const bundledOf = (manifest) => manifest.bundleDependencies ?? manifest.bundledDependencies

// A snapshot's dependencies against the package.json of its package, as
// fetchPackage read it: `hook` is hook.js's.
export function checkDependencies(manifest, pkg, where, hook) {
  const bundled = bundledOf(manifest)
  const read = hook(manifest, `${where}: package.json`)
  const given = new Set([...names(pkg.dependencies), ...names(pkg.optionalDependencies)])
  for (const name of [...names(read.dependencies), ...names(read.optionalDependencies)]) {
    if (bundled === true || (Array.isArray(bundled) && bundled.includes(name)) || given.has(name)) continue
    throw new DeptreeError(`package.json asks for ${quote(name)}, which the lockfile does not give it`, where)
  }
  // A peer resolved is filed as optional where it is optional; pnpm's
  // compatibility database adds peers to a few packages, which the
  // lockfile records among their peers and the package.json does not.
  const optional = new Set([...names(read.optionalDependencies), ...names(manifest.peerDependencies), ...names(manifest.peerDependenciesMeta), ...names(pkg.peerDependencies), ...names(pkg.peerDependenciesMeta)])
  for (const name of names(pkg.optionalDependencies)) {
    if (!optional.has(name)) throw new DeptreeError(`the lockfile gives it ${quote(name)} as optional, which its package.json does not`, where)
  }
}

// A package's files, and its package.json as parsed; the package has to be
// from the registry.
export async function fetchPackage(pkg, where) {
  const { integrity } = pkg.resolution
  const bytes = await getTarball(pkg.name, pkg.version, { tarball: tarballUrl(pkg.name, pkg.version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const files = filesOf(unpack(await decompress(bytes, 'gzip', { limit: MAX_BYTES })), where)
  const manifest = readManifest(files, pkg, where)
  checkManifest(manifest, pkg, where)
  return { files, manifest }
}
