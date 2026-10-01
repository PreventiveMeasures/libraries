// yarn.lock names no projects, so their manifests come by directory. A name of
// a workspace with no entry links it, its version not held to the range.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative, joinRelative } from '../names.js'
import { EMPTY, entries, record, string } from '../shape.js'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']
export const WHERE = 'manifests'

// yarn's resolveRelative: `file:` and `link:` go from the manifest's directory
// to the lockfile's, keeping `./`; absolute ones are refused, the root unknown.
function fromLockfile(range, dir, where) {
  const prefix = /^(?:file|link):/u.exec(range)?.[0]
  if (prefix === undefined && !range.startsWith('/')) return range
  const path = range.slice(prefix?.length ?? 0)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(range)} is an absolute path`, where)
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  const target = checkRelative(joinRelative(dir, segments.length === 0 ? '.' : segments.join('/')), where)
  const dotted = target !== '.' && /^\.(?:\/|$)/u.test(path) && !/^\.{0,2}\//u.test(target)
  return `${prefix}${dotted ? './' : ''}${target}`
}

// yarn drops `//`, a comment, from a dependency list.
function readTargets(value, dir, where, packages, workspaces) {
  const targets = Object.create(null)
  for (const [name, range, here] of entries(value ?? EMPTY, where)) {
    if (name === '//') continue
    const pattern = `${checkName(name, here)}@${fromLockfile(string(range, here), dir, here)}`
    if (pattern in packages) targets[name] = pattern
    else if (workspaces.has(name)) targets[name] = `link:${workspaces.get(name)}`
    else throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile`, here)
  }
  return targets
}

// yarn's parsePatternInfo: it ignores a path ending in `/` or `*` or with `//`.
function readResolutions(value, where) {
  const rules = []
  for (const [path, range, here] of entries(value ?? EMPTY, where)) {
    if (/\/$|\/{2,}|\*+$/u.test(path)) continue
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = checkName(names.at(-1), here)
    rules.push({ path, glob: names.length === 1 ? `**/${path}` : path, name, pattern: `${name}@${string(range, here)}`, where: here })
  }
  return rules
}

// yarn writes no pattern nothing asks for; a resolution's own counts where its
// entry is reached.
function checkReached(importers, packages, resolutions) {
  const reached = new Set()
  const installed = new Set()
  const visit = (targets) => {
    for (const target of Object.values(targets)) {
      if (target.startsWith('link:') || reached.has(target)) continue
      reached.add(target)
      installed.add(packages[target])
    }
  }
  for (const importer of Object.values(importers)) for (const kind of KINDS) visit(importer[kind])
  for (const pkg of installed) {
    visit(pkg.dependencies)
    visit(pkg.optionalDependencies)
  }
  for (const [pattern, pkg] of Object.entries(packages)) {
    if (reached.has(pattern) || (resolutions.has(pattern) && installed.has(pkg))) continue
    throw new LockfileError('nothing asks for it: no manifest, no package and no resolution', at('', pattern))
  }
}

// Also hands resolutions.js the workspaces by name, and the root's resolutions.
export function readImporters(manifests, packages) {
  const workspaces = new Map()
  for (const [dir, manifest, here] of entries(manifests, WHERE)) {
    record(manifest, here)
    if (checkRelative(dir, here) === '.') continue
    const nameAt = at(here, 'name')
    const name = checkName(string(manifest.name, nameAt), nameAt)
    if (workspaces.has(name)) throw new LockfileError(`the name of the workspace ${quote(workspaces.get(name))} too`, nameAt)
    workspaces.set(name, dir)
  }
  const rootAt = at(WHERE, '.')
  const root = manifests['.']
  if (root === undefined) throw new LockfileError('expected the manifest beside the lockfile, "."', WHERE)
  if (workspaces.size > 0 && root.workspaces === undefined) throw new LockfileError('expected workspaces, as there are manifests of workspaces', at(rootAt, 'workspaces'))
  const importers = Object.create(null)
  for (const [dir, manifest, here] of entries(manifests, WHERE)) {
    const importer = Object.create(null)
    for (const kind of KINDS) importer[kind] = readTargets(manifest[kind], dir, at(here, kind), packages, workspaces)
    importers[dir] = importer
  }
  const rules = readResolutions(root.resolutions, at(rootAt, 'resolutions'))
  checkReached(importers, packages, new Set(rules.map((rule) => rule.pattern)))
  return { importers, workspaces, rules }
}
