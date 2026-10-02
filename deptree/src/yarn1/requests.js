// What yarn 1 asks for at the top (install.js's fetchRequestFromCwd).

import { clean, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { matchesGlob } from '../glob.js'
import { cleanDependencies, globsOf } from './manifest.js'

// yarn names the workspace aggregator at random; this stands for it, and
// sorts where a name starting so sorts.
export const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'

const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// In the order yarn's resolveWorkspaces finds them, glob by glob, matches as
// node-glob sorts them; the lockfile reader has held `manifests` to the globs.
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

// The virtual manifest yarn makes of the root and the workspaces.
export function aggregatorOf(root, workspaces) {
  const dependencies = { ...root.dependencies }
  for (const workspace of workspaces.values()) dependencies[workspace.name] = workspace.version
  const manifest = { name: AGGREGATOR, version: '1.0.0', dependencies, devDependencies: { ...root.devDependencies }, optionalDependencies: { ...root.optionalDependencies } }
  return { name: AGGREGATOR, dir: '.', version: '1.0.0', manifest: cleanDependencies(manifest), aggregator: true }
}

// The resolutions as resolution-map.js reads them. One to neither a range
// nor another source, which yarn passes over, the lockfile reader refuses.
export function rulesOf(root) {
  const rules = Object.entries(root.resolutions ?? {}).map(([path, range]) => {
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = names.at(-1)
    if (validRange(range) === null) throw new DeptreeError(`a resolution to ${quote(range)}, no semver range, is not supported`, `manifests["."].resolutions[${quote(path)}]`)
    return { path, name, glob: names.length === 1 ? `**/${path}` : path, pattern: `${name}@${range}` }
  })
  return [...Map.groupBy(rules, ({ name }) => name).values()].flat()
}

// The top-level requests in yarn's order; `asked`, all but the resolutions'.
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
