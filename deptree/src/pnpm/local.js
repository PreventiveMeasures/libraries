// Directories outside node_modules the tree links to or installs, read from the
// project given. Each must hold a package.json, whose bins take their names as
// pnpm links them; but one a link leads to may not be there at all.

import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { basename, dirname, resolve } from '@preventive/vfs/path.js'
import { DeptreeError, difference, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { readText, typeOf } from '../project.js'
import { parseSpec } from './frozen.js'
import { localOf } from './overrides.js'
import { checkManifest } from './package.js'
import { packDirectory } from './packlist.js'

function manifestAt(project, dir, where) {
  const text = readText(project, `/${dir}/package.json`, where)
  if (text === undefined) throw new DeptreeError(`${quote(dir)} holds no package.json in the project given`, where)
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

// The package.json of `dir`, above a directory not there, where pnpm 11
// looks for one whose publishConfig.directory it is, up to /, of which only
// the project is read; a manifest of another kind is refused.
function manifestAbove(project, dir, where) {
  const at = (name) => (dir === '.' ? `/${name}` : `/${dir}/${name}`)
  const text = readText(project, at('package.json'), where)
  if (text !== undefined) return readManifest(text, where)
  const other = ['package.json5', 'package.yaml'].find((name) => typeOf(project, at(name)) !== undefined)
  if (other !== undefined) throw new DeptreeError(`${quote(at(other).slice(1))} is a manifest pnpm 11 may read the bins of a directory below it from, which is not supported`, where)
  return undefined
}

// pnpm links to a directory that is not there, as it warns, and reads no bins
// of it: as of an override to `npm:@scope/name@workspace:^`, which no resolver
// but the one for paths takes, for its `/`. Refused where pnpm 10 links a
// runtime's binary by the directory's name, or pnpm 11 reads the bins of a
// package.json above it whose publishConfig.directory it is.
function missingLinked(project, projects, target, where) {
  if (['node', 'deno', 'bun'].includes(basename(target))) throw new DeptreeError(`${quote(target)} is not in the project given, and pnpm 10 links a runtime's binary by its name, which is not supported`, where)
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    const directory = (projects.get(dir) ?? manifestAbove(project, dir, where))?.publishConfig?.directory
    if (typeof directory === 'string' && resolve('/', dir, directory) === `/${target}`) {
      throw new DeptreeError(`${quote(target)} is not in the project given, and pnpm 11 reads its bins from ${quote(dir)}, whose publishConfig.directory it is, which is not supported`, where)
    }
    if (dir === '.') return {}
  }
}

// A target in node_modules is the tree's, not the project's, and so is never
// taken for one not there.
export function readLinked(links, nodes, projects, project) {
  const linked = new Map()
  if (project === undefined) return linked
  for (const [path, target] of links) {
    if (nodes.has(target) || projects.has(target) || linked.has(target) || target === '..' || target.startsWith('../')) continue
    const missing = !target.split('/').includes('node_modules') && typeOf(project, `/${target}`) === undefined
    linked.set(target, missing ? missingLinked(project, projects, target, quote(path)) : manifestAt(project, target, quote(path)))
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

const optionalPeers = (meta) => Object.entries(meta ?? {}).filter(([, item]) => item?.optional === true).map(([name]) => name).sort()

// `read` is the hooked package.json. A peer may be among the snapshot's
// dependencies and an optional one missing; a `file:` or `link:` one is left to
// package.js's checkDependencies.
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

// pnpm 12's check, before it installs, of each snapshot a project depends on by
// a `file:` specifier to a directory.
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
