// The graph a pnpm 10 install links, as @pnpm/deps.graph-builder builds it
// from a frozen lockfile: a node for each snapshot installed, at
// node_modules/.pnpm/<its directory>/node_modules/<its name>, with its
// dependencies and optional dependencies as children by alias; and, for
// each project, its direct dependencies by alias. A child left out of the
// install is left out of its parent's children too. A `link:` child is the
// directory it names, which is no node. Paths here are relative to the
// lockfile's directory, the root of the tree.

import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { depPathToFilename } from './filename.js'

const VIRTUAL_STORE = 'node_modules/.pnpm'

// A target as a path: where a link leads, which may climb out of the
// lockfile's directory, or the directory of its node in `nodes`; none
// where it has no node, as a snapshot left out of the install has none.
// The lockfile reader holds every other target to be a snapshot.
const childOf = (target, nodes) => (target.startsWith('link:') ? target.slice(5) : nodes.get(target)?.dir)

const childrenOf = (targets, nodes) => new Map(Object.entries(targets).map(([alias, target]) => [alias, childOf(target, nodes)]).filter(([, dir]) => dir !== undefined))

// The graph pnpm 12 hoists from: a node for every snapshot, skipped or
// not, by its directory, its children skipped or not; and each project's
// direct dependencies but its `link:`s, skipped or not, the projects in
// the order of their ids' bytes. `all` holds every snapshot's node.
function hoistingOf(lockfile, all) {
  const nodes = new Map([...all.values()].map((node) => [node.dir, { modules: node.modules, children: childrenOf({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }, all) }]))
  const direct = new Map(Object.keys(lockfile.importers).sort(compareNames).map((id) => {
    const { devDependencies, dependencies, optionalDependencies } = lockfile.importers[id]
    return [id, new Map([...childrenOf({ ...devDependencies, ...dependencies, ...optionalDependencies }, all)].filter(([, dir]) => nodes.has(dir)))]
  }))
  return { nodes, direct }
}

// `nodes` by snapshot key, and `direct`, by project, the children each
// project links: devDependencies first, as pnpm spreads them, which is
// the order hoisting walks them in; and, for pnpm 12, `hoisting`, the
// graph it hoists from. No two snapshots pnpm places may have one
// directory: those it installs, and with pnpm 12, which hoists from them
// too, those it skips.
export async function buildGraph(lockfile, skipped, maxLength, major = 10) {
  const all = new Map()
  const keyByDir = new Map()
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    if (major < 12 && skipped.has(key)) continue
    const store = `${VIRTUAL_STORE}/${await depPathToFilename(key, maxLength, major)}`
    const dir = `${store}/node_modules/${pkg.name}`
    if (keyByDir.has(dir)) throw new DeptreeError(`${quote(keyByDir.get(dir))} and ${quote(key)} would be installed in one directory`, quote(dir))
    keyByDir.set(dir, key)
    all.set(key, { key, pkg, name: pkg.name, dir, modules: `${store}/node_modules` })
  }
  const nodes = new Map([...all].filter(([key]) => !skipped.has(key)))
  for (const node of nodes.values()) {
    node.children = childrenOf({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }, nodes)
  }
  const direct = new Map(Object.entries(lockfile.importers).map(([id, importer]) => [id, childrenOf({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies }, nodes)]))
  return { nodes, direct, hoisting: major >= 12 ? hoistingOf(lockfile, all) : undefined }
}
