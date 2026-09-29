// Which snapshots a pnpm 10 install from a frozen lockfile leaves out: an
// optional one that the host cannot run — its `os`, `cpu` or `libc` do not
// take the host's, or its `engines.node` does not take the Node pnpm runs
// on — and an optional one first reached, depth first from the projects,
// through a snapshot that is not installed. That first reach decides it,
// as it does for pnpm (@pnpm/lockfile.filtering's pkgAllDeps, then
// @pnpm/deps.graph-builder checking every snapshot again), so a snapshot
// reached both ways is left out or not by which way is walked first.
// Anything else incompatible is installed, as pnpm installs it with a
// warning, or refused where `engineStrict` has pnpm refuse it.
//
// The projects are walked in the lockfile's order, which is the order of
// their directories; pnpm walks them in the order it finds them on disk,
// which only a snapshot reached both ways as above can tell apart.

import { satisfies, valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// pnpm's checkList: `any` alone is anything, `!x` excludes, and a list of
// exclusions alone takes what none of them names. The count of exclusions
// runs over every value the host is taken to be, as pnpm counts it.
function checkList(values, list) {
  if (list.length === 1 && list[0] === 'any') return true
  let match = false
  let excluded = 0
  for (const value of values) {
    for (const item of list) {
      if (item.startsWith('!')) {
        if (item.slice(1) === value) return false
        excluded++
      } else if (item === value) match = true
    }
  }
  return match || excluded === list.length
}

// What the host is taken to be: itself, or what `supportedArchitectures`
// lists for each, `current` standing for itself.
const current = (value, supported) => (supported ?? ['current']).map((item) => (item === 'current' ? value : item))

function checkPlatform(pkg, host, supported) {
  const ok = checkList(current(host.os, supported?.os), pkg.os ?? ['any'])
    && checkList(current(host.cpu, supported?.cpu), pkg.cpu ?? ['any'])
    && (host.libc === 'unknown' || checkList(current(host.libc, supported?.libc), pkg.libc ?? ['any']))
  return ok ? undefined : 'platform'
}

function checkEngine(pkg, node) {
  const wanted = pkg.engines.node
  if (!wanted || satisfies(node, wanted, { includePrerelease: true })) return undefined
  if (valid(node) === null) throw new DeptreeError(`${quote(node)} is not an exact version`, 'nodeVersion')
  return 'engine'
}

// A package.json's os, cpu or libc as pnpm's checkList reads one: a string
// is a list of it, and what is not a string in a list is passed over.
function platformList(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  throw new DeptreeError('expected a string or a list of them', where)
}

// A project as pnpm's packageIsInstallable holds it when it reads its
// package.json: a platform the host is not only warns, and so does an
// engines.node it does not take, unless engineStrict; an engines.pnpm it
// does not take is always refused. As pnpm has it, a platform that does
// not match is found first, and the engines are then not looked at.
export function checkProject(manifest, where, { host, settings }) {
  const platform = { os: platformList(manifest.os, `${where}.os`), cpu: platformList(manifest.cpu, `${where}.cpu`), libc: platformList(manifest.libc, `${where}.libc`) }
  if (checkPlatform(platform, host, settings.supportedArchitectures ?? { os: ['current'], cpu: ['current'], libc: ['current'] }) !== undefined) return
  const engines = manifest.engines
  if (engines === undefined || engines === null) return
  const node = settings.nodeVersion ?? host.node
  if (engines.pnpm && !satisfies(host.pnpm, engines.pnpm, { includePrerelease: true })) {
    throw new DeptreeError(`its engines.pnpm, ${quote(String(engines.pnpm))}, does not take pnpm ${host.pnpm}, which pnpm refuses`, where)
  }
  if (settings.engineStrict && checkEngine({ engines }, node) !== undefined) throw new DeptreeError(`its engines.node, ${quote(String(engines.node))}, does not take Node ${node}, which engineStrict refuses`, where)
}

// A check of one snapshot: true where the host can run it, false where it
// is optional and cannot, and null where it cannot but is not optional and
// is installed anyway. With `engineStrict` that last is refused.
export function createCheck({ host, settings }) {
  const node = settings.nodeVersion ?? host.node
  return (key, pkg) => {
    const reason = checkPlatform(pkg, host, settings.supportedArchitectures) ?? checkEngine(pkg, node)
    if (reason === undefined) return true
    if (pkg.optional) return false
    if (settings.engineStrict) throw new DeptreeError(`the host does not take its ${reason === 'platform' ? 'os, cpu or libc' : 'engines.node'}, which engineStrict refuses`, quote(key))
    return null
  }
}

// A reference's key, or the project a `link:` leads to, if it is one.
function split(targets, lockfile) {
  const keys = []
  const projects = []
  for (const target of targets) {
    if (!target.startsWith('link:')) keys.push(target)
    else if (target.slice(5) in lockfile.importers) projects.push(target.slice(5))
  }
  return { keys, projects }
}

// Every snapshot a project depends on, then those of the projects it
// links to that were not walked yet, as pnpm's toImporterDepPaths lists
// them: dependencies, devDependencies, optionalDependencies.
function projectKeys(lockfile, ids, walked) {
  const targets = ids.flatMap((id) => {
    const importer = lockfile.importers[id]
    return Object.values({ ...importer.dependencies, ...importer.devDependencies, ...importer.optionalDependencies })
  })
  const { keys, projects } = split(targets, lockfile)
  const more = projects.filter((id) => !walked.has(id))
  for (const id of more) walked.add(id)
  return more.length === 0 ? keys : [...keys, ...projectKeys(lockfile, more, walked)]
}

// The keys of the snapshots left out. `check` is createCheck's.
export function skippedSnapshots(lockfile, check) {
  const ids = Object.keys(lockfile.importers)
  const walked = new Set(ids)
  const picked = new Set()
  const skipped = new Set()
  const visit = (keys, parentInstallable) => {
    for (const key of keys) {
      if (picked.has(key)) continue
      const pkg = lockfile.packages[key]
      const installable = parentInstallable && check(key, pkg) !== false
      if (!installable && pkg.optional) skipped.add(key)
      picked.add(key)
      const { keys: next, projects } = split(Object.values({ ...pkg.dependencies, ...pkg.optionalDependencies }), lockfile)
      for (const id of projects) walked.add(id)
      visit([...next, ...projectKeys(lockfile, projects, walked)], installable)
    }
  }
  visit(projectKeys(lockfile, ids, walked), true)
  // The graph is built of the rest, each checked again on its own.
  for (const key of picked) {
    if (!skipped.has(key) && check(key, lockfile.packages[key]) === false) skipped.add(key)
  }
  return skipped
}
