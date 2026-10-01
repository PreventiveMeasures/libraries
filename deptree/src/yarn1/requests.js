// What yarn 1 asks for at the top of an install (install.js's
// fetchRequestFromCwd): the workspaces, in the order it finds them; the
// aggregator it makes of them; the root's resolutions, as resolution-map.js
// reads them; and the top-level requests, in order.

import { DeptreeError, quote } from '../error.js'
import { matchesGlob } from './glob.js'
import { cleanDependencies, globsOf } from './manifest.js'

// The name yarn gives the workspace aggregator is random; this stands for
// it, and sorts where a name starting so sorts.
export const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'

const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// The workspaces by name, in the order yarn's resolveWorkspaces finds
// them: each glob in turn, its matches as node-glob sorts them; each with
// its directory, its version as yarn cleans it, and its manifest.
// `manifests` by directory, the root's `.` among them, as the lockfile
// reader has held them to the globs.
export function workspacesOf(manifests, semver) {
  const root = manifests.get('.')
  const workspaces = new Map()
  for (const glob of globsOf(root)) {
    const dirs = [...manifests.keys()].filter((dir) => dir !== '.' && matchesGlob(glob, dir))
    dirs.sort((a, b) => `${a}/package.json`.localeCompare(`${b}/package.json`, 'en'))
    for (const dir of dirs) {
      const manifest = manifests.get(dir)
      if ([...workspaces.values()].some((workspace) => workspace.dir === dir)) continue
      const version = semver.clean(manifest.version, true) || manifest.version
      workspaces.set(manifest.name, { name: manifest.name, dir, version, manifest })
    }
  }
  return workspaces
}

// The aggregator yarn makes of the workspaces: the root's dependencies
// and each workspace at its version, its devDependencies and
// optionalDependencies.
export function aggregatorOf(root, workspaces) {
  const dependencies = { ...root.dependencies }
  for (const workspace of workspaces.values()) dependencies[workspace.name] = workspace.version
  const manifest = { name: AGGREGATOR, version: '1.0.0', dependencies, devDependencies: { ...root.devDependencies }, optionalDependencies: { ...root.optionalDependencies } }
  return { name: AGGREGATOR, dir: '.', version: '1.0.0', manifest: cleanDependencies(manifest), aggregator: true }
}

// The resolutions yarn reads: a path of package names, the last the one
// resolved, to a range or another source. One to another source is
// refused here, as no source but the registry is supported; one to what
// is neither, which yarn passes over, the lockfile reader has refused.
export function rulesOf(root, semver) {
  const byName = new Map()
  for (const [path, range] of Object.entries(root.resolutions ?? {})) {
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = names.at(-1)
    if (semver.validRange(range) === null) throw new DeptreeError(`a resolution to ${quote(range)}, no semver range, is not supported`, `manifests["."].resolutions[${quote(path)}]`)
    const glob = names.length === 1 ? `**/${path}` : path
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push({ path, name, range, glob, pattern: `${name}@${range}` })
  }
  return [...byName.values()].flat()
}

// The top-level requests, as yarn makes them and in its order.
export function topRequests(root, workspaces, rules) {
  const requests = rules.map((rule) => ({ pattern: rule.pattern, optional: false }))
  const patterns = []
  const push = (deps, optional) => {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const pattern = `${name}@${range}`
      patterns.push(pattern)
      requests.push({ pattern, optional })
    }
  }
  push(root.dependencies, false)
  push(root.devDependencies, false)
  push(root.optionalDependencies, true)
  if (workspaces.size > 0) {
    push({ [AGGREGATOR]: '1.0.0' }, false)
    const implicit = {}
    for (const workspace of workspaces.values()) {
      if (workspace.aggregator || KINDS.some((kind) => Object.hasOwn(root[kind] ?? {}, workspace.name))) continue
      implicit[workspace.name] = workspace.version
    }
    push(implicit, false)
  }
  return { requests, patterns }
}
