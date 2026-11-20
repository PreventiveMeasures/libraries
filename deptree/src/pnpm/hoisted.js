// The hoisted linker: pnpm's tree of the lockfile, every project under the root, hoisted by @yarnpkg/nm for
// pnpm 10 and 11 (nm-hoist.js; pnpm 11's 4.0.7 to 4.1.1 differs only with hoistingLimits, not supported) and its
// own for pnpm 12 (real-hoist12.js), each package copied to node_modules/<alias> where it lands; `link:`s linked

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { valid } from '@preventive/upstream/semver.js'
import { compareNames, relative } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'
import { REGULAR, WORKSPACE, depthFirst, hoist, reachable } from './nm-hoist.js'
import { hoist12 } from './real-hoist12.js'

// pnpm's name@version of a snapshot, by which it takes every snapshot of a package for the first. A
// directory has no version, so all of one name are one; from pnpm 11.24 (`directories`) each is its own.
export function packageIdOf(key, pkg, directories = false) {
  if (directories && pkg.resolution.type === 'directory') return key
  const base = packageKeyOf(key)
  const name = base.slice(0, base.indexOf('@', 1))
  const version = pkg.resolution.type === 'directory' ? undefined : valid(base.slice(name.length + 1)) ?? undefined
  return `${name}@${version}`
}

// pnpm 12's pkg_id: the key with its peers and patch hash cut, from the
// first `(` of a key that ends in `)`; but a `file:` directory's, each
// variant of which is a copy of its own, unlike a tarball's, is the key.
export function pkgId12(key) {
  const sep = key.indexOf('@', 1)
  const open = key.endsWith(')') ? key.indexOf('(', sep) : -1
  const base = open === -1 ? key : key.slice(0, open)
  const version = base.slice(sep + 1).replace(/^runtime:/u, '')
  if (!version.startsWith('file:')) return base
  const lower = version.replace(/[A-Z]/gu, (char) => char.toLowerCase())
  return ['.tgz', '.tar.gz', '.tar'].some((ext) => lower.endsWith(ext)) ? base : key
}

export const modulesOf = (id) => (id === '.' ? 'node_modules' : `${id}/node_modules`)

// A project's dependencies as pnpm reads them from the lockfile, a link
// spelled from the project, as pnpm writes it.
function asWritten(id, deps) {
  return Object.fromEntries(Object.entries(deps).map(([alias, target]) => [alias, target.startsWith('link:') ? `link:${relative(`/${id}`, `/${target.slice(5)}`)}` : target]))
}

// A link pnpm from 11.28.1 takes for one into the package that asks for it,
// which it does not hoist: `link:<root>/` and a plain path.
export const rootLink = (ref) => ref.startsWith('link:<root>/') && ref.slice('link:<root>/'.length).split('/').every((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('\\') && !name.includes(':'))

// The tree hoisted, a node by alias and snapshot, each made once, its dependencies before the next, depth
// first. pnpm 12 (`pnpm12`) takes dependencies and projects in the order of their aliases and ids, leaves a
// project's `link:`s out, and takes a package by its pkg_id
export function hoisterTree(lockfile, autoInstallPeers, { directories = false, rootLinks = false, pnpm12 = false } = {}) {
  const nodes = new Map()
  const referenceById = new Map()
  const entriesOf = (deps) => (pnpm12 ? Object.entries(deps).sort(([a], [b]) => compareNames(a, b)) : Object.entries(deps))
  const nodeOf = (alias, ref) => {
    if (ref.startsWith('link:')) return { name: alias, identName: alias, reference: ref, dependencyKind: rootLinks && rootLink(ref) ? WORKSPACE : REGULAR, dependencies: new Set(), peerNames: new Set() }
    const pkg = lockfile.packages[ref]
    const id = pnpm12 ? pkgId12(ref) : packageIdOf(ref, pkg, directories)
    if (!referenceById.has(id)) referenceById.set(id, ref)
    const peerNames = new Set(autoInstallPeers ? [] : [...Object.keys(pkg.peerDependencies), ...pkg.transitivePeerDependencies])
    return { name: alias, identName: pkg.name, reference: referenceById.get(id), dependencyKind: REGULAR, dependencies: new Set(), peerNames }
  }
  const toTree = (deps) => {
    const top = new Set()
    depthFirst({ items: entriesOf(deps).values(), into: top }, ([alias, ref], { into }) => {
      const key = `${alias}:${ref}`
      const made = !nodes.has(key)
      if (made) nodes.set(key, nodeOf(alias, ref))
      const node = nodes.get(key)
      into.add(node)
      if (!made || ref.startsWith('link:')) return undefined
      const pkg = lockfile.packages[ref]
      return { items: entriesOf({ ...pkg.dependencies, ...pkg.optionalDependencies }).values(), into: node.dependencies }
    })
    return top
  }
  const projectNode = (id, name, reference) => {
    const { dependencies, devDependencies, optionalDependencies } = lockfile.importers[id]
    const deps = asWritten(id, { ...dependencies, ...devDependencies, ...optionalDependencies })
    return { name, identName: name, reference, peerNames: new Set(), dependencyKind: WORKSPACE, dependencies: toTree(pnpm12 ? Object.fromEntries(Object.entries(deps).filter(([, ref]) => !ref.startsWith('link:'))) : deps) }
  }
  const tree = projectNode('.', '.', '')
  const ids = Object.keys(lockfile.importers).filter((id) => id !== '.' && !lockfile.importers[id].made)
  for (const id of pnpm12 ? ids.sort(compareNames) : ids) tree.dependencies.add(projectNode(id, encodeURIComponent(id), `workspace:${id}`))
  return tree
}

// pnpm reads a package's link as its writer left it, which the lockfile
// reader does not keep; pnpm 12 links one nowhere, or one into the package.
export function checkNoPackageLinks(lockfile) {
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    for (const [alias, target] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (target.startsWith('link:')) throw new DeptreeError('a package\'s `link:` dependency is not supported with the hoisted linker', `packages[${quote(key)}].dependencies[${quote(alias)}]`)
    }
  }
}

// The tree as hoisted, of nodes with a name, an identName, references and
// dependencies; with `directories` from pnpm 11.24, `rootLinks` from
// 11.28.1, and `pnpm12`'s hoister for pnpm 12.
export function hoistedTree(lockfile, autoInstallPeers, bounds, options = {}) {
  checkNoPackageLinks(lockfile)
  return (options.pnpm12 ? hoist12 : hoist)(hoisterTree(lockfile, autoInstallPeers, options), bounds)
}

// Each copy pnpm makes, a parent before what lands in its node_modules; the projects' `link:`s and node_modules;
// and what is left out, `skipped` (hoisted all the same) and what `leftOut` takes. pnpm 10 and 11 walk the root's
// packages first, 12 each project where the root has it; importers made for projects pnpm has none for are not
export function hoistedLayout(lockfile, { autoInstallPeers, skipped, leftOut = () => false, checkAlias, ...options }, bounds) {
  const tree = hoistedTree(lockfile, autoInstallPeers, bounds, options)
  const projectOf = (dep) => (dep.references.values().next().value.startsWith('workspace:') ? dep.references.values().next().value.slice('workspace:'.length) : undefined)
  const top = options.pnpm12 ? [...tree.dependencies] : [...tree.dependencies].sort((a, b) => (projectOf(a) === undefined ? 0 : 1) - (projectOf(b) === undefined ? 0 : 1))
  const placed = new Map()
  const left = new Set(skipped)
  const projects = ['node_modules']
  depthFirst({ modules: 'node_modules', top: true, items: top.values() }, (dep, frame) => {
    const [key] = dep.references
    if (key.startsWith('workspace:')) {
      if (!frame.top) return undefined
      projects.push(modulesOf(projectOf(dep)))
      return { modules: modulesOf(projectOf(dep)), items: dep.dependencies.values() }
    }
    if (left.has(key) || !(key in lockfile.packages)) return undefined
    const pkg = lockfile.packages[key]
    if (leftOut(key, pkg)) {
      left.add(key)
      return undefined
    }
    checkAlias?.(dep.name, frame.modules)
    const dir = `${frame.modules}/${dep.name}`
    placed.set(dir, { key, pkg, name: pkg.name, dir, modules: frame.modules, alias: dep.name })
    return { modules: `${dir}/node_modules`, items: dep.dependencies.values() }
  })
  return { placed, links: projectLinks(lockfile), projects, skipped: left }
}

// Each project's `link:` dependencies, by where each goes in its
// node_modules, to the directory from the lockfile's.
export function projectLinks(lockfile) {
  const links = new Map()
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    for (const [alias, target] of Object.entries({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies })) {
      if (target.startsWith('link:')) links.set(`${modulesOf(id)}/${alias}`, target.slice('link:'.length))
    }
  }
  return links
}

// From pnpm 11.28, each project in `names` linked into the root's node_modules by its name where a hoist
// pattern matches it, unless the root depends on that name or a package landed there by it, case folded
export function workspaceHoists(placed, lockfile, { hoistPattern, publicHoistPattern }, names) {
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const { dependencies, devDependencies, optionalDependencies } = lockfile.importers['.']
  const taken = new Set(Object.keys({ ...dependencies, ...devDependencies, ...optionalDependencies }).map((alias) => alias.toLowerCase()))
  for (const { modules, alias } of placed.values()) if (modules === 'node_modules') taken.add(alias.toLowerCase())
  const links = new Map()
  for (const [id, name] of names) {
    if ((!isPublic(name) && !isPrivate(name)) || taken.has(name.toLowerCase())) continue
    taken.add(name.toLowerCase())
    links.set(`node_modules/${name}`, id)
  }
  return links
}

// pnpm's build pass where any patch is configured, scripts ignored or not: each package patched or with an
// install script built at the first reached copy (of its snapshot, or from 11.23 its package: `idOf`), its
// files then linked into the others as the refusals say. Which copy it builds turns on an order not followed.
export function hoistedBuilds(byDir, projects, builds, { hardlinks, keepsModules = false, idOf = (key) => key, changesOf, pnpm = '10' }) {
  const first = new Map()
  for (const node of byDir.values()) if (!first.has(idOf(node.key))) first.set(idOf(node.key), node.dir)
  const dropping = mayDrop(byDir)
  const childrenOf = (node) => Object.entries({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }).map(([alias, key]) => [alias, first.get(idOf(key))]).filter(([, dir]) => dir !== undefined)
  const tops = byDir.values().filter((node) => projects.has(node.modules)).map((node) => node.dir)
  const reached = reachable(tops, (dir) => childrenOf(byDir.get(dir)).map(([, child]) => child))
  const built = []
  for (const [key, copies] of Map.groupBy(byDir.values(), (node) => node.key)) {
    const [node] = copies
    if (!builds(node)) continue
    const candidates = copies.filter((copy) => reached.has(copy.dir)).map((copy) => copy.dir)
    const patched = node.pkg.patchHash !== undefined
    if (candidates.length === 0) {
      if (patched) throw new DeptreeError(`pnpm ${pnpm} reaches none of its copies through the dependencies it builds by, and leaves it unpatched, which is not supported`, quote(key))
      continue
    }
    if (copies.length > 1 && !hardlinks) {
      if (patched) throw new DeptreeError('pnpm 10 before 10.21 patches one of its copies alone, and leaves the others as they were, which is not supported', quote(key))
    } else if (copies.length > 1 && keepsModules) {
      for (const { path, change } of patched ? changesOf(node) : []) {
        if (change === 'delete') throw new DeptreeError(`pnpm ${pnpm} patches one of its copies, and links its files into the others, which keep ${quote(path)} the patch deletes, which is not supported`, quote(key))
        if (path.split('/').includes('node_modules')) throw new DeptreeError(`pnpm ${pnpm} patches one of its copies, and links its files but those under a node_modules into the others, which leaves ${quote(path)} unpatched there, which is not supported`, quote(key))
      }
    } else if (copies.length > 1) {
      const own = node.files.keys().find((path) => path.split('/').includes('node_modules'))
      if (own !== undefined) throw new DeptreeError(`pnpm ${pnpm} builds one of its copies where any patch is configured, and makes the others hardlinks of it, with no ${quote(own)}, which is not supported`, quote(key))
      const nested = dropping.get(key)
      if (nested !== undefined) throw new DeptreeError(`pnpm ${pnpm} builds one of its copies where any patch is configured, and makes the others hardlinks of it, dropping their node_modules: ${quote(`${nested.dir}/node_modules`)} may be dropped, which is not supported`, quote(key))
    }
    built.push({ key, copies: copies.map((copy) => copy.dir), candidates, children: childrenOf(node) })
  }
  return built
}

// The packages of several copies, by key, with the copy whose node_modules pnpm 10.21 to before 11.25 may
// drop where any patch is configured: it puts hardlinks of one built copy in place of the others
export function mayDrop(placed) {
  const placedIn = new Set(placed.values().map((node) => node.modules))
  const dropping = new Map()
  for (const [key, copies] of Map.groupBy(placed.values(), (node) => node.key)) {
    const nested = copies.length > 1 ? copies.find((copy) => placedIn.has(`${copy.dir}/node_modules`)) : undefined
    if (nested !== undefined) dropping.set(key, nested)
  }
  return dropping
}

// For a tree's layout alone, which fetches nothing, any of `dropping` is
// refused, as which pnpm builds is not known.
export function checkNoneDropped(dropping, pnpm) {
  const [first] = dropping
  if (first === undefined) return
  const [key, nested] = first
  throw new DeptreeError(`pnpm ${pnpm} builds one of its copies where any patch is configured, if it is patched or has an install script, and makes the others hardlinks of it, dropping their node_modules: ${quote(`${nested.dir}/node_modules`)} may be dropped, which with sizeEstimateOnly is not known, and is not supported`, quote(key))
}

// What linkBins reads to link bins (bins.js): each node_modules pnpm fills,
// with what it put there, the projects' first, then each project's with its
// links too.
export function hoistedModules(byDir, links, projects, manifests, lockfile) {
  const placedIn = new Map()
  const add = (modules, alias, dir) => {
    if (!placedIn.has(modules)) placedIn.set(modules, [])
    placedIn.get(modules).push([alias, dir])
  }
  for (const { dir, modules, alias } of byDir.values()) add(modules, alias, dir)
  const filled = [...projects, ...byDir.keys().map((dir) => `${dir}/node_modules`)]
  const all = filled.filter((dir) => placedIn.has(dir)).map((dir) => ({ dir, entries: placedIn.get(dir) }))
  for (const [path, target] of links) {
    const end = path.lastIndexOf('/node_modules/') + '/node_modules'.length
    add(path.slice(0, end), path.slice(end + 1), target)
  }
  for (const id of Object.keys(lockfile.importers)) {
    const dir = modulesOf(id)
    if (placedIn.has(dir)) all.push({ dir, entries: placedIn.get(dir), manifest: manifests.get(id) })
  }
  return all
}

// The snapshots `pnpm install --prod` would install, by pnpm's name@version.
export function prodPackages(lockfile, skipped, directories) {
  const edges = ({ dependencies, optionalDependencies }) => [...Object.values(dependencies), ...Object.values(optionalDependencies)]
  const reached = reachable(Object.values(lockfile.importers).flatMap(edges), (key) => edges(lockfile.packages[key]), (key) => key.startsWith('link:') || skipped.has(key))
  return new Set(reached.values().map((key) => packageIdOf(key, lockfile.packages[key], directories)))
}

