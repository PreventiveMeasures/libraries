// The projects a yarn.lock installs, which it does not name: the manifest
// beside it, `.`, and each workspace its `workspaces` finds, which the
// caller reads, as yarn does with JSON.parse, and hands over by directory
// from the lockfile's. What each asks for leads to the entry of its
// pattern; a workspace's name the lockfile has no entry for leads to that
// workspace, linked, as yarn records none. Whether the workspace's version
// is in the range asked for is not checked here.
//
// Every pattern is then held to be asked for, as yarn writes no other: by a
// manifest, by a package, or, beside the patterns a resolution was applied
// to, by the root's `resolutions` as the resolution's own. Whether each
// resolution applies where it was, resolutions.js has.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative, joinRelative } from '../names.js'
import { EMPTY, entries, record, string } from '../shape.js'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']
export const WHERE = 'manifests'

// yarn's resolveRelative: a `file:` or `link:` path in a manifest is
// rewritten from the manifest's directory to the lockfile's, with the `./`
// it had, as yarn records it; one that is absolute is refused, as the
// lockfile's directory is not known here.
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

// By alias, the pattern of each dependency, or `link:` and a workspace's
// directory. yarn drops a `//` from a list, which is a comment.
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

// yarn's parsePackagePath and parsePatternInfo; a path that ends in `/` or
// `*` or has `//` in it is ignored, as yarn does.
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

// The patterns asked for, and the packages they lead to, each read once.
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

// `manifests` by directory, `.` among them; `packages` what packages.js
// reads. The importers come back, and for resolutions.js the workspaces,
// by name, and the rules of the root's `resolutions`, in order.
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
