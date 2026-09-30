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
// to, by the root's `resolutions` as the resolution's own; and every entry
// that gives a pattern asking for the registry what another names, to a
// resolution that applies to every request of it, as resolutions.js has.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative, joinRelative } from '../names.js'
import { EMPTY, entries, record, string } from '../shape.js'
import { checkResolutions, readResolutions } from './resolutions.js'

const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']
const WHERE = 'manifests'

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

function checkReached(importers, packages, resolutions) {
  const reached = new Set()
  const queue = []
  const visit = (targets) => {
    for (const target of Object.values(targets)) {
      if (target.startsWith('link:') || reached.has(target)) continue
      reached.add(target)
      queue.push(target)
    }
  }
  for (const importer of Object.values(importers)) for (const kind of KINDS) visit(importer[kind])
  while (queue.length > 0) {
    const pkg = packages[queue.pop()]
    visit(pkg.dependencies)
    visit(pkg.optionalDependencies)
  }
  const installed = new Set([...reached].map((pattern) => packages[pattern]))
  for (const [pattern, pkg] of Object.entries(packages)) {
    if (reached.has(pattern) || (resolutions.has(pattern) && installed.has(pkg))) continue
    throw new LockfileError('nothing asks for it: no manifest, no package and no resolution', at('', pattern))
  }
}

// `manifests` by directory, `.` among them; `packages` and `mixed` what
// packages.js reads.
export function readImporters(manifests, packages, mixed) {
  record(manifests, WHERE)
  const workspaces = new Map()
  for (const [dir, manifest, here] of entries(manifests, WHERE)) {
    record(manifest, here)
    if (checkRelative(dir, here) === '.') continue
    const name = checkName(string(manifest.name, at(here, 'name')), at(here, 'name'))
    if (workspaces.has(name)) throw new LockfileError(`the name of the workspace ${quote(workspaces.get(name))} too`, at(here, 'name'))
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
  checkResolutions(mixed, rules, manifests, importers, packages)
  return importers
}
