// Directories outside node_modules the tree links to or installs, read from the
// project given. Each must hold a package.json, whose bins take their names as
// pnpm links them.

import { compareVersions, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, difference, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { readText, typeOf } from '../project.js'
import { extensionsOf } from './extensions.js'
import { parseSpec } from './frozen.js'
import { localOf } from './overrides.js'
import { checkManifest } from './package.js'
import { packDirectory } from './packlist.js'

export function manifestAt(project, dir, where) {
  const text = readText(project, `/${dir}/package.json`, where)
  if (text === undefined) throw new DeptreeError(`${quote(dir)} ${typeOf(project, `/${dir}`) === undefined ? 'is not in' : 'holds no package.json in'} the project given`, where)
  return readManifest(text, where)
}

// The directories `file:` overrides have pnpm install.
export function checkLocalOverrides(overrides, project) {
  const installed = new Set()
  for (const { selector, local } of overrides) {
    if (local === undefined) continue
    const where = `overrides[${quote(selector)}]`
    if (project === undefined) throw new DeptreeError(`an override to a directory, ${quote(local.dir)}, is read only from a project given`, where)
    if (local.protocol === 'file:' && typeOf(project, `/${local.dir}`) === 'file') throw new DeptreeError(`${quote(local.dir)} is a file in the project given, and an override to a tarball is not supported`, where)
    manifestAt(project, local.dir, where)
    if (local.protocol === 'file:') installed.add(local.dir)
  }
  return installed
}

// The lockfile records no version for a `file:` dependency's directory.
export function readDirectoryPackage(project, pkg, where, host) {
  const { directory } = pkg.resolution
  const manifest = manifestAt(project, directory, where)
  if (manifest.name !== pkg.name) throw new DeptreeError(`its package.json is for ${quote(String(manifest.name))}`, where)
  const files = packDirectory(project, directory, manifest, host.pnpm, where)
  checkManifest(manifest, pkg, where, host.major)
  return { files, manifest, local: true }
}

// pnpm takes `npm:@scope/name@workspace:<range>` for a path, for its `/`,
// which no other resolver takes, and links to a directory of that name.
const ALIASED = /(?:^|\/)(npm:(@[^/]+\/[^/]+)@(workspace:[^/]*))$/u

// pnpm links to a directory that is not there all the same: pnpm 10 and 11
// warn as they resolve, and none does as a frozen install. Refused, with the
// project given or, for the spec it takes for a path, without, but where the
// project holds a directory of that name.
export function readLinked(links, nodes, projects, project) {
  const linked = new Map()
  for (const [path, target] of links) {
    if (nodes.has(target) || projects.has(target) || linked.has(target) || target === '..' || target.startsWith('../')) continue
    const aliased = ALIASED.exec(target)
    if (aliased !== null && (project === undefined || typeOf(project, `/${target}`) === undefined)) {
      const [, spec, name, range] = aliased
      throw new DeptreeError(`pnpm takes ${quote(spec)} for a path, for its "/", and links to ${quote(target)}${project === undefined ? '' : ', which is not there'}; ${quote(range.replace(':', `:${name}@`))} is the spec that links the workspace package`, quote(path))
    }
    if (project !== undefined) linked.set(target, manifestAt(project, target, quote(path)))
  }
  return linked
}

// Whether pnpm 12 takes `target` to be what `spec` asks for.
function resolvesTo(name, spec, target, packages) {
  if (target.startsWith('link:')) return false
  const locked = packages[target]
  const { name: wanted, range } = parseSpec(spec, name)
  if (locked.name !== wanted) return false
  const version = valid(locked.version ?? '')
  return validRange(range) === null || version === null || satisfies(version, range)
}

const partition = (items, test) => [items.filter(test), items.filter((item) => !test(item))]
const optionalPeers = (meta) => Object.entries(meta ?? {}).filter(([, item]) => item?.optional === true).map(([name]) => name).sort()

// `read` is the hooked package.json. A peer only in peerDependenciesMeta is one
// at `*`, and an optional peer may be among the optional dependencies too; one
// in both lists is optional, at the dependency's range.
function checkFresh(read, pkg, { packages, autoInstallPeers }, where) {
  const outdated = (why) => new DeptreeError(`the lockfile is not up to date with its package.json, which a frozen install of pnpm 12 refuses: ${why}`, where)
  const optional = read.optionalDependencies ?? {}
  const [both, deps] = partition(Object.entries(read.dependencies ?? {}), ([name]) => Object.hasOwn(optional, name))
  const wanted = { dependencies: Object.fromEntries(deps), optionalDependencies: { ...optional, ...Object.fromEntries(both) } }
  const optionalNames = optionalPeers(read.peerDependenciesMeta)
  const peers = { ...Object.fromEntries(optionalNames.map((name) => [name, '*'])), ...read.peerDependencies }
  const others = { dependencies: read.peerDependencies ?? {}, optionalDependencies: Object.fromEntries(optionalNames.map((name) => [name, peers[name]])) }
  for (const kind of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[kind])) {
      if (!Object.hasOwn(wanted[kind], name) && !Object.hasOwn(others[kind], name)) throw outdated(`${kind}.${name} is not one it asks for`)
    }
    for (const [name, spec] of Object.entries(wanted[kind])) {
      const target = pkg[kind][name]
      if (target === undefined) {
        if (kind === 'optionalDependencies') continue
        throw outdated(`${kind}.${name} is not in the lockfile`)
      }
      if (spec.startsWith('file:') || spec.startsWith('link:')) continue
      if (spec.startsWith('workspace:')) throw new DeptreeError(`a workspace: dependency, ${quote(name)}, of a directory pnpm 12 holds to the lockfile is not supported`, where)
      if (localOf(spec, where) !== undefined || !resolvesTo(name, spec, target, packages)) throw outdated(`${kind}.${name} is not resolved as it asks`)
    }
  }
  // A peer that is its own dependency too may go unrecorded, but where pnpm installs it.
  const unrecorded = (name) => !Object.hasOwn(pkg.peerDependencies, name) && Object.hasOwn(read.dependencies ?? {}, name) && !(autoInstallPeers && !optionalNames.includes(name))
  const recorded = Object.fromEntries(Object.entries(peers).filter(([name]) => !unrecorded(name)))
  const peersDiffer = difference(recorded, pkg.peerDependencies, ['its package.json', 'the lockfile'])
  if (peersDiffer !== undefined) throw outdated(`its peerDependencies are not the lockfile's: ${peersDiffer}`)
  if (JSON.stringify(optionalNames.filter((name) => Object.hasOwn(recorded, name))) !== JSON.stringify(optionalPeers(pkg.peerDependenciesMeta))) throw outdated('which of its peers are optional is not the lockfile\'s')
}

// pnpm 12's check, before it installs, of each snapshot a project depends on by
// a `file:` specifier to a directory. Before 12.17.0 it reads the package.json
// without its extensions, refusing the lockfile it wrote of one extended.
export function createFreshnessCheck(lockfile, { pnpm, major }, extensions = [], autoInstallPeers = true) {
  if (major < 12) return undefined
  const unextended = compareVersions(pnpm, '12.17.0') < 0
  const direct = new Set()
  for (const importer of Object.values(lockfile.importers)) {
    for (const [name, target] of Object.entries({ ...importer.dependencies, ...importer.devDependencies, ...importer.optionalDependencies })) {
      const spec = importer.specifiers[name]
      if (target.startsWith('link:') || !spec?.startsWith('file:') || /\.(?:tgz|tar\.gz|tar)$/u.test(spec)) continue
      if (lockfile.packages[target].resolution.type === 'directory') direct.add(target)
    }
  }
  return (node, read) => {
    if (!direct.has(node.key)) return
    const where = quote(node.key)
    if (unextended && extensionsOf(extensions, read, where).length > 0) throw new DeptreeError('a package extension names it, and pnpm 12 before 12.17.0 holds a directory to its package.json without one, which is not supported', where)
    checkFresh(read, lockfile.packages[node.key], { packages: lockfile.packages, autoInstallPeers }, where)
  }
}
