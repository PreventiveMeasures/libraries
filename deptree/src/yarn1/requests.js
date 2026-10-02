// What yarn 1 asks for at the top of an install (install.js's
// fetchRequestFromCwd): the workspaces, in the order it finds them; the
// aggregator it makes of them; the root's resolutions, as resolution-map.js
// reads them; and the top-level requests, in order.

import { clean, validRange } from '@preventive/upstream/semver.js'
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
export function workspacesOf(manifests) {
  const root = manifests.get('.')
  const workspaces = new Map()
  const found = new Set()
  for (const glob of globsOf(root)) {
    const dirs = [...manifests.keys()].filter((dir) => dir !== '.' && !found.has(dir) && matchesGlob(glob, dir))
    dirs.sort((a, b) => `${a}/package.json`.localeCompare(`${b}/package.json`, 'en'))
    for (const dir of dirs) {
      found.add(dir)
      const manifest = manifests.get(dir)
      const version = clean(manifest.version, { loose: true }) || manifest.version
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
export function rulesOf(root) {
  const byName = new Map()
  for (const [path, range] of Object.entries(root.resolutions ?? {})) {
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = names.at(-1)
    if (validRange(range) === null) throw new DeptreeError(`a resolution to ${quote(range)}, no semver range, is not supported`, `manifests["."].resolutions[${quote(path)}]`)
    const glob = names.length === 1 ? `**/${path}` : path
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push({ path, name, range, glob, pattern: `${name}@${range}` })
  }
  return [...byName.values()].flat()
}

// The top-level requests, as yarn makes them and in its order; and of
// them, `asked`, those the project makes, the resolutions' aside, each
// optional or not, dev or not, in its order too.
export function topRequests(root, workspaces, rules) {
  const asked = []
  const push = (deps, optional, dev = false) => {
    for (const [name, range] of Object.entries(deps ?? {})) asked.push({ pattern: `${name}@${range}`, optional, dev })
  }
  push(root.dependencies, false)
  push(root.devDependencies, false, true)
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
  return { requests: [...rules.map((rule) => ({ pattern: rule.pattern, optional: false })), ...asked], asked }
}
