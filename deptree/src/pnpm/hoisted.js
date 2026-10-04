// Where the hoisted linker (nodeLinker: hoisted) of pnpm 10 and 11 puts
// each package: @pnpm/real-hoist makes a tree of the lockfile, the root's
// dependencies and each other project's under the root, which @yarnpkg/nm
// hoists (nm-hoist.js; what pnpm 11 has of it, 4.0.7 to 4.1.1, differs
// only with hoistingLimits, which is not supported); each package is then
// copied to node_modules/<alias> under where it landed, and each project's
// own lands in its node_modules. A project's `link:` dependencies are linked
// there, as are none of a package's.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { valid } from '@preventive/upstream/semver.js'
import { relative } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'
import { REGULAR, WORKSPACE, hoist } from './nm-hoist.js'

// pnpm's name@version of a snapshot, by which it takes every snapshot of a
// package for the first it comes to. A directory has no version in the
// lockfile, so all of one name are one; from pnpm 11.24 (`directories`),
// each snapshot of one is its own.
export function packageIdOf(key, pkg, directories = false) {
  if (directories && pkg.resolution.type === 'directory') return key
  const base = packageKeyOf(key)
  const name = base.slice(0, base.indexOf('@', 1))
  const version = pkg.resolution.type === 'directory' ? undefined : valid(base.slice(name.length + 1)) ?? undefined
  return `${name}@${version}`
}

const modulesOf = (id) => (id === '.' ? 'node_modules' : `${id}/node_modules`)

// A project's dependencies as pnpm reads them from the lockfile, a link
// spelled from the project, as pnpm writes it.
function asWritten(id, deps) {
  return Object.fromEntries(Object.entries(deps).map(([alias, target]) => [alias, target.startsWith('link:') ? `link:${relative(`/${id}`, `/${target.slice(5)}`)}` : target]))
}

// A link pnpm from 11.28.1 takes for one into the package that asks for it,
// which it does not hoist: `link:<root>/` and a plain path.
const rootLink = (ref) => ref.startsWith('link:<root>/') && ref.slice('link:<root>/'.length).split('/').every((name) => name !== '' && name !== '.' && name !== '..' && !name.includes('\\') && !name.includes(':'))

// real-hoist's tree: a node by alias and snapshot, each made once and with
// its own dependencies made before the next, depth first as pnpm recurses,
// on a stack.
function treeOf(lockfile, autoInstallPeers, { directories, rootLinks }) {
  const nodes = new Map()
  const referenceById = new Map()
  const toTree = (deps) => {
    const top = new Set()
    const stack = [{ entries: Object.entries(deps).values(), into: top }]
    while (stack.length > 0) {
      const { value, done } = stack.at(-1).entries.next()
      if (done) {
        stack.pop()
        continue
      }
      const [alias, ref] = value
      const link = ref.startsWith('link:')
      const key = `${alias}:${ref}`
      let node = nodes.get(key)
      if (node === undefined) {
        if (link) {
          node = { name: alias, identName: alias, reference: ref, dependencyKind: rootLinks && rootLink(ref) ? WORKSPACE : REGULAR, dependencies: new Set(), peerNames: new Set() }
          nodes.set(key, node)
        } else {
          const pkg = lockfile.packages[ref]
          const id = packageIdOf(ref, pkg, directories)
          if (!referenceById.has(id)) referenceById.set(id, ref)
          node = {
            name: alias,
            identName: pkg.name,
            reference: referenceById.get(id),
            dependencyKind: REGULAR,
            dependencies: new Set(),
            peerNames: new Set(autoInstallPeers ? [] : [...Object.keys(pkg.peerDependencies), ...pkg.transitivePeerDependencies]),
          }
          nodes.set(key, node)
          stack.at(-1).into.add(node)
          stack.push({ entries: Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).values(), into: node.dependencies })
          continue
        }
      }
      stack.at(-1).into.add(node)
    }
    return top
  }
  const root = lockfile.importers['.']
  const tree = {
    name: '.',
    identName: '.',
    reference: '',
    peerNames: new Set(),
    dependencyKind: WORKSPACE,
    dependencies: toTree(asWritten('.', { ...root.dependencies, ...root.devDependencies, ...root.optionalDependencies })),
  }
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    if (id === '.' || importer.made) continue
    tree.dependencies.add({
      name: encodeURIComponent(id),
      identName: encodeURIComponent(id),
      reference: `workspace:${id}`,
      peerNames: new Set(),
      dependencyKind: WORKSPACE,
      dependencies: toTree(asWritten(id, { ...importer.dependencies, ...importer.devDependencies, ...importer.optionalDependencies })),
    })
  }
  return tree
}

// pnpm reads a package's link as its writer left it, which the lockfile
// reader does not keep.
function checkNoPackageLinks(lockfile) {
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    for (const [alias, target] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (target.startsWith('link:')) throw new DeptreeError('a package\'s `link:` dependency is not supported with the hoisted linker', `packages[${quote(key)}].dependencies[${quote(alias)}]`)
    }
  }
}

// The tree as hoisted, of nodes with a name, an identName, references and
// dependencies; with `directories` from pnpm 11.24, and `rootLinks` from
// 11.28.1.
export function hoistedTree(lockfile, autoInstallPeers, bounds, { directories = false, rootLinks = false } = {}) {
  checkNoPackageLinks(lockfile)
  return hoist(treeOf(lockfile, autoInstallPeers, { directories, rootLinks }), bounds)
}

// Each directory a package is copied to, from the lockfile's, in the order
// pnpm makes them, a parent before what lands in its node_modules, with the
// snapshot copied there, the node_modules it is in and its alias there; the
// `link:`s of each project, by where they go; and the node_modules of the
// projects pnpm fills, the root's first. `skipped` are the snapshots left
// out, which are hoisted all the same. pnpm hoists from the importers the
// lockfile has, not those made for projects it has none for.
export function hoistedLayout(lockfile, { autoInstallPeers, skipped, directories = false, rootLinks = false }, bounds) {
  const tree = hoistedTree(lockfile, autoInstallPeers, bounds, { directories, rootLinks })
  const placed = new Map()
  const place = (modules, deps) => {
    const stack = [{ modules, deps: deps.values() }]
    while (stack.length > 0) {
      const frame = stack.at(-1)
      const { value: dep, done } = frame.deps.next()
      if (done) {
        stack.pop()
        continue
      }
      const [key] = dep.references
      if (skipped.has(key) || key.startsWith('workspace:') || !(key in lockfile.packages)) continue
      const dir = `${frame.modules}/${dep.name}`
      placed.set(dir, { key, modules: frame.modules, alias: dep.name })
      stack.push({ modules: `${dir}/node_modules`, deps: dep.dependencies.values() })
    }
  }
  place('node_modules', tree.dependencies)
  const projects = ['node_modules']
  for (const dep of tree.dependencies) {
    const [reference] = dep.references
    if (!reference.startsWith('workspace:')) continue
    const modules = modulesOf(reference.slice('workspace:'.length))
    projects.push(modules)
    place(modules, dep.dependencies)
  }
  const links = new Map()
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    for (const [alias, target] of Object.entries({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies })) {
      if (target.startsWith('link:')) links.set(`${modulesOf(id)}/${alias}`, target.slice(5))
    }
  }
  return { placed, links, projects }
}

// pnpm from 11.28 links each project named in `names` into the root's
// node_modules by its name where a hoist pattern matches it, unless the root
// depends on that name, or a package landed there by it, with their case
// folded.
export function workspaceHoists(placed, lockfile, { hoistPattern, publicHoistPattern }, names) {
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const { dependencies, devDependencies, optionalDependencies } = lockfile.importers['.']
  const taken = new Set([...Object.keys({ ...dependencies, ...devDependencies, ...optionalDependencies })].map((alias) => alias.toLowerCase()))
  for (const { modules, alias } of placed.values()) if (modules === 'node_modules') taken.add(alias.toLowerCase())
  const links = new Map()
  for (const [id, name] of names) {
    if ((!isPublic(name) && !isPrivate(name)) || taken.has(name.toLowerCase())) continue
    taken.add(name.toLowerCase())
    links.set(`node_modules/${name}`, id)
  }
  return links
}

// What pnpm's build pass does where any patch is configured, which it runs
// though scripts are ignored: it builds each package patched or with an
// install script in one of its copies, the first it comes to of those a
// project's node_modules reaches through each package's dependencies, each
// at the first copy of its snapshot, or from pnpm 11.23 of its package
// (`idOf`). Then it links the built copy's files into every other: from
// 10.21 (`hardlinks`) it puts a copy of hardlinks in place of the copy, with
// no node_modules, which drops the copy's own; before, in place, where a
// file is not already, which leaves the others unpatched. From pnpm 11.25
// (`keepsModules`) it links each file but those under a node_modules in
// place of the copy's own, and leaves the copy's node_modules and what the
// built one has not. Which copy it builds turns on its build order, which is
// not followed here. `projects` are the node_modules of the projects;
// `byDir` the copies, in the order pnpm makes them; `changesOf` the changes
// of a patched one's patch; `pnpm` the version, for what is refused.
export function hoistedBuilds(byDir, projects, builds, { hardlinks, keepsModules = false, idOf = (key) => key, changesOf, pnpm = '10' }) {
  const first = new Map()
  const placedIn = new Set()
  for (const node of byDir.values()) {
    if (!first.has(idOf(node.key))) first.set(idOf(node.key), node.dir)
    placedIn.add(node.modules)
  }
  const childrenOf = (node) => Object.entries({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }).map(([alias, key]) => [alias, first.get(idOf(key))]).filter(([, dir]) => dir !== undefined)
  const reached = new Set()
  const pending = [...byDir.values()].filter((node) => projects.has(node.modules)).map((node) => node.dir)
  while (pending.length > 0) {
    const dir = pending.pop()
    if (reached.has(dir)) continue
    reached.add(dir)
    for (const [, child] of childrenOf(byDir.get(dir))) pending.push(child)
  }
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
      const nested = copies.find((copy) => placedIn.has(`${copy.dir}/node_modules`))
      if (nested !== undefined) throw new DeptreeError(`pnpm ${pnpm} builds one of its copies where any patch is configured, and makes the others hardlinks of it, dropping their node_modules: ${quote(`${nested.dir}/node_modules`)} may be dropped, which is not supported`, quote(key))
    }
    built.push({ key, copies: copies.map((copy) => copy.dir), candidates, children: childrenOf(node) })
  }
  return built
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
  const filled = [...projects, ...[...byDir.keys()].map((dir) => `${dir}/node_modules`)]
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
  const reached = new Set()
  const pending = Object.values(lockfile.importers).flatMap(({ dependencies, optionalDependencies }) => [...Object.values(dependencies), ...Object.values(optionalDependencies)])
  while (pending.length > 0) {
    const key = pending.pop()
    if (key.startsWith('link:') || reached.has(key) || skipped.has(key)) continue
    reached.add(key)
    const pkg = lockfile.packages[key]
    pending.push(...Object.values(pkg.dependencies), ...Object.values(pkg.optionalDependencies))
  }
  return new Set([...reached].map((key) => packageIdOf(key, lockfile.packages[key], directories)))
}

