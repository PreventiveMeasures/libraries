// Where pnpm 10's hoisted linker (nodeLinker: hoisted) puts each package:
// @pnpm/real-hoist makes a tree of the lockfile, the root's dependencies and
// each other project's under the root, which @yarnpkg/nm hoists
// (nm-hoist.js); each package is then copied to node_modules/<alias> under
// where it landed, and each project's own lands in its node_modules. A
// project's `link:` dependencies are linked there, as are none of a
// package's.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { valid } from '@preventive/upstream/semver.js'
import { relative } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { WORKSPACE, hoist } from './nm-hoist.js'

const REGULAR = 0

// pnpm's name@version of a snapshot, by which it takes every snapshot of a
// package for the first it comes to. A directory has no version in the
// lockfile, so all of one name are one.
export function packageIdOf(key, pkg) {
  const base = packageKeyOf(key)
  const name = base.slice(0, base.indexOf('@', 1))
  const version = pkg.resolution.type === 'directory' ? undefined : valid(base.slice(name.length + 1)) ?? undefined
  return `${name}@${version}`
}

// A project's dependencies as pnpm reads them from the lockfile, a link
// spelled from the project, as pnpm writes it.
function asWritten(id, deps) {
  return Object.fromEntries(Object.entries(deps).map(([alias, target]) => [alias, target.startsWith('link:') ? `link:${relative(`/${id}`, `/${target.slice(5)}`)}` : target]))
}

// real-hoist's tree: a node by alias and snapshot, each made once and with
// its own dependencies made before the next, depth first as pnpm recurses,
// on a stack.
function treeOf(lockfile, autoInstallPeers) {
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
          node = { name: alias, identName: alias, reference: ref, dependencyKind: REGULAR, dependencies: new Set(), peerNames: new Set() }
          nodes.set(key, node)
        } else {
          const pkg = lockfile.packages[ref]
          const id = packageIdOf(ref, pkg)
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
// dependencies.
export function hoistedTree(lockfile, autoInstallPeers, bounds) {
  checkNoPackageLinks(lockfile)
  return hoist(treeOf(lockfile, autoInstallPeers), bounds)
}

// Each directory a package is copied to, from the lockfile's, in the order
// pnpm makes them, a parent before what lands in its node_modules, with the
// snapshot copied there, the node_modules it is in and its alias there; the
// `link:`s of each project, by where they go; and the projects pnpm fills
// the node_modules of, the root first. `skipped` are the snapshots left out,
// which are hoisted all the same. pnpm hoists from the importers the
// lockfile has, not those made for projects it has none for.
export function hoistedLayout(lockfile, { autoInstallPeers, skipped }, bounds) {
  const tree = hoistedTree(lockfile, autoInstallPeers, bounds)
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
  const projects = ['.']
  for (const dep of tree.dependencies) {
    const [reference] = dep.references
    if (!reference.startsWith('workspace:')) continue
    const id = reference.slice('workspace:'.length)
    projects.push(id)
    place(`${id}/node_modules`, dep.dependencies)
  }
  const links = new Map()
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    for (const [alias, target] of Object.entries({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies })) {
      if (target.startsWith('link:')) links.set(`${id === '.' ? '' : `${id}/`}node_modules/${alias}`, target.slice(5))
    }
  }
  return { placed, links, projects }
}

// The snapshots `pnpm install --prod` would install, by pnpm's name@version.
export function prodPackages(lockfile, skipped) {
  const reached = new Set()
  const pending = Object.values(lockfile.importers).flatMap(({ dependencies, optionalDependencies }) => [...Object.values(dependencies), ...Object.values(optionalDependencies)])
  while (pending.length > 0) {
    const key = pending.pop()
    if (key.startsWith('link:') || reached.has(key) || skipped.has(key)) continue
    reached.add(key)
    const pkg = lockfile.packages[key]
    pending.push(...Object.values(pkg.dependencies), ...Object.values(pkg.optionalDependencies))
  }
  return new Set([...reached].map((key) => packageIdOf(key, lockfile.packages[key])))
}

