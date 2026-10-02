// Directories outside node_modules the tree links to or installs, read
// from the project (project.js) where one is given: those local overrides
// name, and every other a `link:` leads to that is no project and is under
// the lockfile's directory. Each has to hold a package.json there, whose
// bins take their names as pnpm links them. An override to a directory is
// read only from a project given. One by `file:` has pnpm install the
// directory as a package, of the files npm-packlist picks (packlist.js);
// one to a tarball is refused. pnpm 12 holds one a project depends on to
// the lockfile before it installs (createFreshnessCheck).

import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, difference, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { readText, typeOf } from '../project.js'
import { targetName, versionRange } from './frozen.js'
import { localOf } from './overrides.js'
import { packDirectory } from './packlist.js'

function manifestAt(project, dir, where) {
  const text = readText(project, `/${dir}/package.json`, where)
  if (text === undefined) throw new DeptreeError(`${quote(dir)} holds no package.json in the project given`, where)
  return readManifest(text, where)
}

// `overrides` is listOverrides's. It gives back the directories `file:`
// overrides have pnpm install.
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

// The package at the directory a `file:` dependency names, from `project`:
// its files as npm-packlist picks them, and its package.json, which has
// to be for the name the lockfile has; the lockfile has no version.
export function readDirectoryPackage(project, pkg, where, major) {
  const { directory } = pkg.resolution
  const manifest = manifestAt(project, directory, where)
  if (manifest.name !== pkg.name) throw new DeptreeError(`its package.json is for ${quote(String(manifest.name))}`, where)
  return { files: packDirectory(project, directory, manifest, major, where), manifest }
}

// By directory, the package.json of each directory the tree links to that
// is no node of `nodes`, no project of `projects`, and under the
// lockfile's directory, read from `project`; none without one.
export function readLinked(links, nodes, projects, project) {
  const linked = new Map()
  if (project === undefined) return linked
  for (const [path, target] of links) {
    if (nodes.has(target) || projects.has(target) || linked.has(target) || target === '..' || target.startsWith('../')) continue
    linked.set(target, manifestAt(project, target, quote(path)))
  }
  return linked
}

// Whether pnpm 12 takes a dependency on `name` by `spec`, a specifier not
// to a directory, to be what the lockfile resolved it to, `target`: a
// package of the name it asks for, `npm:` aliasing another, at a version
// in its range, where it is a range and the version is one.
function resolvesTo(name, spec, target, packages) {
  if (target.startsWith('link:')) return false
  const locked = packages[target]
  if (locked.name !== targetName(spec, name)) return false
  const range = versionRange(spec)
  const version = valid(locked.version ?? '')
  return validRange(range) === null || version === null || satisfies(version, range)
}

const optionalPeers = (meta) => Object.entries(meta ?? {}).filter(([, item]) => item?.optional === true).map(([name]) => name).sort()

// pnpm 12 holds a directory a project depends on by `file:` to the
// lockfile as it reads the directory's package.json, overridden, `read`:
// each dependency the snapshot `pkg` has is one it asks for, a peer among
// them, and each it asks for is there, resolved as it asks, an optional one
// there or not; its peers are exactly what the lockfile records, and so is
// which of them are optional. A `file:` or `link:` one is held to where it
// leads by package.js's checkDependencies; a path alone, or `workspace:`,
// is refused. `packages` is the lockfile's.
function checkFresh(read, pkg, packages, where) {
  const outdated = (why) => new DeptreeError(`the lockfile is not up to date with its package.json, which a frozen install of pnpm 12 refuses: ${why}`, where)
  const wanted = { dependencies: read.dependencies ?? {}, optionalDependencies: read.optionalDependencies ?? {} }
  const peers = read.peerDependencies ?? {}
  for (const [kind, others] of [['dependencies', peers], ['optionalDependencies', {}]]) {
    for (const name of Object.keys(pkg[kind])) {
      if (!Object.hasOwn(wanted[kind], name) && !Object.hasOwn(others, name)) throw outdated(`${kind}.${name} is not one it asks for`)
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
  const peersDiffer = difference(peers, pkg.peerDependencies, ['its package.json', 'the lockfile'])
  if (peersDiffer !== undefined) throw outdated(`its peerDependencies are not the lockfile's: ${peersDiffer}`)
  if (JSON.stringify(optionalPeers(read.peerDependenciesMeta)) !== JSON.stringify(optionalPeers(pkg.peerDependenciesMeta))) throw outdated('which of its peers are optional is not the lockfile\'s')
}

// pnpm 12's check, before it installs, of each snapshot a project depends
// on by a `file:` specifier to a directory: undefined for another pnpm.
// It is given the node of a snapshot and its package.json as hook.js reads
// it.
export function createFreshnessCheck(lockfile, major) {
  if (major < 12) return undefined
  const direct = new Set()
  for (const importer of Object.values(lockfile.importers)) {
    for (const [name, target] of Object.entries({ ...importer.dependencies, ...importer.devDependencies, ...importer.optionalDependencies })) {
      const spec = importer.specifiers[name]
      if (target.startsWith('link:') || !spec?.startsWith('file:') || /\.(?:tgz|tar\.gz|tar)$/u.test(spec)) continue
      if (lockfile.packages[target].resolution.type === 'directory') direct.add(target)
    }
  }
  return (node, read) => {
    if (direct.has(node.key)) checkFresh(read, node.pkg, lockfile.packages, quote(node.key))
  }
}
