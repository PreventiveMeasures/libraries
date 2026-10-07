// A registry package as pnpm installs it: its tarball read as @pnpm/store.cafs
// reads it, and held to what npm packs, more than pnpm holds it to. A
// dependency the lockfile left out of a snapshot would leave the package to
// find it wherever it is hoisted, if anywhere.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { checkNesting } from '../manifest.js'
import { isInside } from '../mount.js'
import { fetchTarball, sameFile } from '../tarball.js'
import { localOf } from './overrides.js'

function nameOf(stored) {
  const slash = stored.indexOf('/')
  let name = slash === -1 ? stored : stored.slice(slash + 1)
  if (name.includes('./')) name = normalize(`/${name}`).slice(1)
  return name.replaceAll('//', '/')
}

// pnpm 9, 10 and 11 drop a name's first segment at a `\` as at a `/` where the
// ustar header holds the name, and pnpm 10 and 11, where a name has a `.\`,
// turn each `\` into a `/` before normalizing it; pnpm 12 takes every `\` for
// a separator, and fails on a `..` that makes.
function filesOf(entries, where) {
  const files = new Map()
  const tops = new Set()
  for (const entry of entries) {
    if (entry.storedName.includes('\\')) throw new DeptreeError(`${quote(entry.storedName)} has a backslash, which pnpm may take for a separator, and that is not supported`, where)
    if (entry.type === 'directory') continue
    if (entry.type !== 'file') throw new DeptreeError(`${quote(entry.name)} is a ${entry.type}, which is not supported`, where)
    tops.add(entry.storedName.slice(0, Math.max(entry.storedName.indexOf('/'), 0)))
    if (tops.size > 1 || tops.has('')) throw new DeptreeError('the tarball has files under more than one directory, or at its top', where)
    const name = nameOf(entry.storedName)
    if (!isInside(name)) {
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

// Undefined where `bin` names none beside a directories.bin: pnpm resolves that
// as having no bins and pnpm 11 rewrites a snapshot as having some, so bins are
// linked as the lockfile has it.
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
  checkNesting(manifest, `${where}: package.json`)
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new DeptreeError(`package.json is for ${quote(`${manifest.name}@${manifest.version}`)}`, where)
  return manifest
}

// npm's abbreviated metadata, which pnpm resolves from unless a setting such
// as supportedArchitectures.libc has it ask for the full document, has no
// libc, nor has the package.json pnpm 9 and 10 keep in the store: a lockfile
// may leave out a libc the package.json has. One it names is held to it.
export function checkManifest(manifest, pkg, where, major) {
  for (const field of ['os', 'cpu', 'libc']) {
    if (field === 'libc' && pkg.libc === undefined) continue
    if (!same(manifest[field], pkg[field])) throw new DeptreeError(`package.json's ${field} is not the lockfile's`, where)
  }
  const has = hasBin(manifest, major)
  if (has !== undefined && has !== pkg.hasBin) throw new DeptreeError(`package.json ${pkg.hasBin ? 'has no bins, and the lockfile says it has' : 'has bins, and the lockfile says it has none'}`, where)
  if (!same(listed(bundledOf(manifest)), listed(pkg.bundledDependencies))) throw new DeptreeError('package.json bundles other than the lockfile says', where)
}

const bundledOf = (manifest) => manifest.bundleDependencies ?? manifest.bundledDependencies

// pnpm 10 writes an empty list of bundled dependencies, pnpm 11 none; for a
// `false`, as react@16.14.0's package.json has, pnpm 10, 11 and 12 write none,
// and npm publishes none.
const listed = (bundled) => (bundled === false || (Array.isArray(bundled) && bundled.length === 0) ? undefined : bundled)

// `read` is the package.json as hook.js's hook has it, and `packages` the
// lockfile's, by which a `file:` target is the directory it resolves to.
export function checkDependencies(manifest, read, pkg, packages, where) {
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
    if (local === undefined || target === `link:${local.dir}` || (local.protocol === 'file:' && packages[target]?.resolution.directory === local.dir)) continue
    throw new DeptreeError(`the lockfile gives it ${quote(name)} as ${quote(target)}, and its package.json, overridden, names ${quote(local.dir)}`, where)
  }
  // A resolved optional peer is filed as optional, and pnpm's compatibility
  // database adds peers to a few packages that their package.json lacks.
  const optional = new Set([...names(read.optionalDependencies), ...names(manifest.peerDependencies), ...names(manifest.peerDependenciesMeta), ...names(pkg.peerDependencies), ...names(pkg.peerDependenciesMeta)])
  for (const name of names(pkg.optionalDependencies)) {
    if (!optional.has(name)) throw new DeptreeError(`the lockfile gives it ${quote(name)} as optional, which its package.json does not`, where)
  }
}

export async function fetchPackage(pkg, where, major, fetching) {
  const { entries, about } = await fetchTarball(pkg.name, pkg.version, pkg.resolution.integrity, where, fetching)
  const files = filesOf(entries, where)
  const manifest = readManifest(files, pkg, where)
  checkManifest(manifest, pkg, where, major)
  return { files, manifest, about }
}
