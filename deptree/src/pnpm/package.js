// A registry package as pnpm installs it from its tarball, whose entries
// are read as @pnpm/store.cafs reads them: the first segment of each name
// dropped whatever it is, only files kept, executable by all or by none.
// It is held to what npm packs, more than pnpm holds it to: a gzipped
// tarball, every file under one directory, no links or devices, and no
// name twice as different files. Its package.json must agree with what
// the lockfile recorded, and every dependency it asks for (through the
// read-package hook, hook.js) must be among each of its snapshots',
// bundled or optional ones aside: a lockfile that left one out would leave
// the package to find it wherever it is hoisted, if anywhere.

import { normalize } from '@preventive/vfs/path.js'
import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { DeptreeError, quote } from '../error.js'
import { fetchTarball, sameFile } from '../tarball.js'
import { localOf } from './overrides.js'

// pnpm's name for an entry: past the first `/` of the name as stored,
// normalized where it has a `./` in it, a `//` made one.
function nameOf(stored) {
  const slash = stored.indexOf('/')
  let name = slash === -1 ? stored : stored.slice(slash + 1)
  if (name.includes('./')) name = normalize(`/${name}`).slice(1)
  return name.replaceAll('//', '/')
}

// Each file's path in the package to its { data, mode }.
function filesOf(entries, where, major) {
  const files = new Map()
  const tops = new Set()
  for (const entry of entries) {
    if (major >= 12 && entry.storedName.includes('\\')) throw new DeptreeError(`${quote(entry.storedName)} has a backslash, which pnpm 12 takes for a separator, and that is not supported`, where)
    if (entry.type === 'directory') continue
    if (entry.type !== 'file') throw new DeptreeError(`${quote(entry.name)} is a ${entry.type}, which is not supported`, where)
    tops.add(entry.storedName.slice(0, Math.max(entry.storedName.indexOf('/'), 0)))
    if (tops.size > 1 || tops.has('')) throw new DeptreeError('the tarball has files under more than one directory, or at its top', where)
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
// Where `bin` names none and there is a directories.bin, pnpm resolves it
// as having none and pnpm 11 rewrites a snapshot as having some, so it is
// undefined and bins are linked as the lockfile has it.
function hasBin({ bin, directories }, major) {
  if (major >= 12) {
    const named = typeof bin === 'string' ? bin !== '' : bin !== null && typeof bin === 'object' && !Array.isArray(bin) && Object.keys(bin).length > 0
    return named || (directories !== null && typeof directories === 'object' && !Array.isArray(directories) && typeof directories.bin === 'string' && directories.bin !== '')
  }
  if (bin == null) return Boolean(directories?.bin)
  if (bin && Object.keys(bin).length > 0) return true
  return directories?.bin ? undefined : false
}

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
export function checkManifest(manifest, pkg, where, major) {
  for (const field of ['os', 'cpu', 'libc']) {
    if (!same(manifest[field], pkg[field])) throw new DeptreeError(`package.json's ${field} is not the lockfile's`, where)
  }
  const has = hasBin(manifest, major)
  if (has !== undefined && has !== pkg.hasBin) throw new DeptreeError(`package.json ${pkg.hasBin ? 'has no bins, and the lockfile says it has' : 'has bins, and the lockfile says it has none'}`, where)
  if (!same(listed(bundledOf(manifest)), listed(pkg.bundledDependencies))) throw new DeptreeError('package.json bundles other than the lockfile says', where)
}

const bundledOf = (manifest) => manifest.bundleDependencies ?? manifest.bundledDependencies

// Bundled dependencies as the lockfile records them, where pnpm 10 writes
// an empty list and pnpm 11 leaves it out.
const listed = (bundled) => (Array.isArray(bundled) && bundled.length === 0 ? undefined : bundled)

// A snapshot's dependencies against its package.json, `read` being it as
// hook.js's hook has it. One the overridden package.json names a directory
// for must be linked there, as pnpm writes it.
export function checkDependencies(manifest, read, pkg, where) {
  const bundled = bundledOf(manifest)
  const given = new Set([...names(pkg.dependencies), ...names(pkg.optionalDependencies)])
  for (const name of [...names(read.dependencies), ...names(read.optionalDependencies)]) {
    if (bundled === true || (Array.isArray(bundled) && bundled.includes(name)) || given.has(name)) continue
    throw new DeptreeError(`package.json asks for ${quote(name)}, which the lockfile does not give it`, where)
  }
  for (const [name, spec] of [...Object.entries(read.dependencies ?? {}), ...Object.entries(read.optionalDependencies ?? {})]) {
    const target = pkg.dependencies[name] ?? pkg.optionalDependencies[name]
    if (target === undefined) continue
    const local = localOf(spec, `${where}: package.json`)
    if (local === undefined || target === `link:${local.dir}` || (local.protocol === 'file:' && packageKeyOf(target).endsWith(`@file:${local.dir}`))) continue
    throw new DeptreeError(`the lockfile gives it ${quote(name)} as ${quote(target)}, and its package.json, overridden, names ${quote(local.dir)}`, where)
  }
  // A resolved optional peer is filed as optional; pnpm's compatibility
  // database adds peers to a few packages, which the lockfile records and
  // the package.json does not.
  const optional = new Set([...names(read.optionalDependencies), ...names(manifest.peerDependencies), ...names(manifest.peerDependenciesMeta), ...names(pkg.peerDependencies), ...names(pkg.peerDependenciesMeta)])
  for (const name of names(pkg.optionalDependencies)) {
    if (!optional.has(name)) throw new DeptreeError(`the lockfile gives it ${quote(name)} as optional, which its package.json does not`, where)
  }
}

// A registry package's files and its package.json as parsed.
export async function fetchPackage(pkg, where, major) {
  const { entries } = await fetchTarball(pkg.name, pkg.version, pkg.resolution.integrity, where)
  const files = filesOf(entries, where, major)
  const manifest = readManifest(files, pkg, where)
  checkManifest(manifest, pkg, where, major)
  return { files, manifest }
}
