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
//
// pnpm 11 walks breadth first, and by the kind of each edge rather than of
// each snapshot: an optional dependency the host cannot run is not taken,
// and what a taken package requires is taken whether the host can run it
// or not, with a warning; each reachable snapshot not taken is left out.
// Where a package of an optional edge names no os, cpu or libc, pnpm 11
// infers them from its name, as `@nx/nx-win32-arm64-msvc` names win32.
//
// pnpm 12 leaves out the same, but refuses with engineStrict whatever it
// installs that the host cannot run, the lockfile's optional mark or not,
// and holds a patched package's published engines to the host as it walks
// it. Of a project it checks only the root's engines.node, and only with
// engineStrict. It reads an engines.node npm's semver does not, or a
// range of a `-` with an `x`, otherwise than npm's semver, which is
// refused where it would decide what is installed.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// pnpm's checkList: `any` alone is anything, `!x` excludes, and a list of
// exclusions alone takes what none of them names. pnpm 10 counts the
// exclusions over every value the host is taken to be, so a list of them
// takes nothing where the host is taken to be more than one thing; pnpm 11
// does not. pnpm 12 takes, of each value, the first item that names it.
function checkList(values, list, major) {
  if (list.length === 1 && list[0] === 'any') return true
  let match = false
  let excluded = 0
  for (const value of values) {
    for (const item of list) {
      if (item.startsWith('!')) {
        if (item.slice(1) === value) return false
        excluded++
      } else if (item === value) {
        match = true
        if (major >= 12) break
      }
    }
  }
  return match || (major >= 11 ? list.every((item) => item.startsWith('!')) : excluded === list.length)
}

// pnpm 11's inferPlatformFromPackageName: the os, cpu and libc the words
// of a package's name, less its scope, say it is for.
const OS_WORDS = { __proto__: null, aix: 'aix', android: 'android', darwin: 'darwin', macos: 'darwin', osx: 'darwin', freebsd: 'freebsd', linux: 'linux', netbsd: 'netbsd', openbsd: 'openbsd', openharmony: 'openharmony', sunos: 'sunos', win32: 'win32', windows: 'win32' }
const CPU_WORDS = { __proto__: null, arm: 'arm', armv6: 'arm', armv7: 'arm', arm64: 'arm64', aarch64: 'arm64', ia32: 'ia32', loong64: 'loong64', mips64el: 'mips64el', ppc64: 'ppc64', ppc64le: 'ppc64', riscv64: 'riscv64', s390x: 's390x', x64: 'x64', amd64: 'x64', wasm32: 'wasm32' }
const LIBC_WORDS = { __proto__: null, glibc: 'glibc', gnu: 'glibc', gnueabihf: 'glibc', musl: 'musl', musleabihf: 'musl' }
function inferPlatform(name) {
  const words = name.slice(name.indexOf('/') + 1).toLowerCase().split(/[-_.]/u)
  const pick = (table) => {
    const values = [...new Set(words.map((word) => table[word]).filter((value) => value !== undefined))]
    return values.length > 0 ? values : undefined
  }
  return { os: pick(OS_WORDS), cpu: pick(CPU_WORDS), libc: pick(LIBC_WORDS) }
}

// pnpm 11's effectivePlatform, for a package checked as optional.
function effectivePlatform(pkg) {
  if (pkg.os !== undefined && pkg.cpu !== undefined && pkg.libc !== undefined) return pkg
  const inferred = inferPlatform(pkg.name)
  const declares = pkg.os !== undefined || pkg.cpu !== undefined || pkg.libc !== undefined
  if (inferred.os === undefined && (!declares || (inferred.cpu === undefined && inferred.libc === undefined))) return pkg
  return { ...pkg, os: pkg.os ?? inferred.os, cpu: pkg.cpu ?? inferred.cpu, libc: pkg.libc ?? inferred.libc }
}

// What the host is taken to be: itself, or what `supportedArchitectures`
// lists for each, `current` standing for itself.
const current = (value, supported) => (supported ?? ['current']).map((item) => (item === 'current' ? value : item))

const takesPlatform = (pkg, host, supported) => checkList(current(host.os, supported?.os), pkg.os ?? ['any'], host.major)
  && checkList(current(host.cpu, supported?.cpu), pkg.cpu ?? ['any'], host.major)
  && (host.libc === 'unknown' || checkList(current(host.libc, supported?.libc), pkg.libc ?? ['any'], host.major))

const takesEngine = (engines, node) => !engines.node || satisfies(node, engines.node, { includePrerelease: true })

// Refuses an engines.node, `what`, that pnpm 12 may read otherwise than
// npm's semver: it drops what of a range it cannot parse, where npm's
// takes none of it, and reads a `-` range with an `x` as taking nothing.
function checkSure12(range, where, what = 'its engines.node') {
  if (typeof range !== 'string' || (validRange(range) !== null && !(/\s-\s/u.test(range) && /[*xX]/u.test(range)))) return
  throw new DeptreeError(`${what}, ${quote(range)}, pnpm 12 reads otherwise than npm's semver, which is not supported`, where)
}

// The Node pnpm checks engines.node against: nodeVersion, else the Node
// the root's engines.runtime pins, else the host's.
const nodeOf = ({ host, settings }) => settings.nodeVersion ?? settings.runtimeNodeVersion ?? host.node

// With engineStrict, pnpm 11 passes over the engines the lockfile records
// of a patched snapshot, and holds those of its package.json, once
// patched, to the Node instead.
const patchedLater = ({ host, settings }) => host.major >= 11 && settings.engineStrict === true

// A package.json's os, cpu or libc as pnpm's checkList reads one: a string
// is a list of it, and what is not a string in a list is passed over.
function platformList(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  throw new DeptreeError('expected a string or a list of them', where)
}

// pnpm 12 checks the root project's engines.node, where it is text, with
// engineStrict alone.
function checkRoot12(manifest, where, context) {
  const range = manifest.engines?.node
  if (!context.settings.engineStrict || typeof range !== 'string' || range === '') return
  const node = nodeOf(context)
  checkSure12(range, where)
  if (!takesEngine({ node: range }, node)) throw new DeptreeError(`its engines.node, ${quote(range)}, does not take Node ${node}, which engineStrict refuses`, where)
}

// A project as pnpm's packageIsInstallable holds it when it reads its
// package.json: a platform the host is not only warns, and so does an
// engines.node it does not take, unless engineStrict; an engines.pnpm it
// does not take is always refused. As pnpm has it, a platform that does
// not match is found first, and the engines are then not looked at.
// pnpm 12's is checkRoot12, of the root alone.
export function checkProject(manifest, where, { host, settings, root }) {
  if (host.major >= 12) {
    if (root) checkRoot12(manifest, where, { host, settings })
    return
  }
  const platform = { os: platformList(manifest.os, `${where}.os`), cpu: platformList(manifest.cpu, `${where}.cpu`), libc: platformList(manifest.libc, `${where}.libc`) }
  if (!takesPlatform(platform, host, settings.supportedArchitectures)) return
  const engines = manifest.engines
  if (engines === undefined || engines === null) return
  const node = nodeOf({ host, settings })
  if (engines.pnpm && !satisfies(host.pnpm, engines.pnpm, { includePrerelease: true })) {
    throw new DeptreeError(`its engines.pnpm, ${quote(String(engines.pnpm))}, does not take pnpm ${host.pnpm}, which pnpm refuses`, where)
  }
  if (settings.engineStrict && !takesEngine(engines, node)) throw new DeptreeError(`its engines.node, ${quote(String(engines.node))}, does not take Node ${node}, which engineStrict refuses`, where)
}

// A check of one snapshot: true where the host can run it, false where it
// is optional and cannot, and null where it cannot but is not optional and
// is installed anyway. With `engineStrict` that last is refused, where the
// lockfile does not mark the snapshot optional, or with pnpm 12. pnpm 10
// takes a snapshot to be optional as the lockfile marks it; pnpm 11 as the
// edge it is reached by. A patched one's engines wait for its package.json,
// patched (patchedLater), but where pnpm 12 is `walking` the lockfile,
// which holds it to its published ones.
function createCheck(context) {
  const { host, settings } = context
  const node = nodeOf(context)
  const later = patchedLater(context)
  return (key, pkg, optional = pkg.optional, walking = false) => {
    const platform = takesPlatform(host.major >= 11 && optional ? effectivePlatform(pkg) : pkg, host, settings.supportedArchitectures)
    const engines = later && !(walking && host.major >= 12) && pkg.patchHash !== undefined ? {} : pkg.engines
    if (host.major >= 12 && platform && (optional || settings.engineStrict)) checkSure12(engines.node, quote(key))
    if (platform && takesEngine(engines, node)) return true
    if (optional) return false
    if (settings.engineStrict && (host.major >= 12 || !pkg.optional)) throw new DeptreeError(`the host does not take its ${platform ? 'engines.node' : 'os, cpu or libc'}, which engineStrict refuses`, quote(key))
    return null
  }
}

// A check of a patched package's package.json, once patched, where pnpm
// makes one (patchedLater): it fails where the Node is not taken; where
// the package is optional, it removes it from the tree it has linked,
// which is refused too. pnpm 12 holds it to nodeVersion, else the host's
// Node, whatever the root's engines.runtime pins.
export function createPatchedCheck(context) {
  if (!patchedLater(context)) return undefined
  const { host, settings } = context
  const node = host.major >= 12 ? settings.nodeVersion ?? host.node : nodeOf(context)
  return (manifest, where) => {
    if (manifest.engines === undefined || manifest.engines === null) return
    if (host.major >= 12) checkSure12(manifest.engines.node, where, 'the engines.node of its package.json, patched')
    if (takesEngine(manifest.engines, node)) return
    throw new DeptreeError(`its package.json, patched, has an engines.node, ${quote(String(manifest.engines.node))}, that does not take Node ${node}, which pnpm ${host.major} refuses with engineStrict, or removes the package for where it is optional`, where)
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

// pnpm 11's filterLockfileByImportersAndEngine: the snapshots left out,
// and those installed although the host cannot run them.
function skippedSnapshots11(lockfile, check) {
  const edgesOf = (deps, optional) => Object.values(deps).filter((target) => !target.startsWith('link:')).map((key) => ({ key, optional }))
  const queue = Object.values(lockfile.importers).flatMap((importer) => [...edgesOf(importer.dependencies, false), ...edgesOf(importer.devDependencies, false), ...edgesOf(importer.optionalDependencies, true)])
  const starts = queue.map(({ key }) => key)
  const installed = new Set()
  const required = new Set()
  // Each snapshot reached, and whether the host cannot run it, as checked
  // where an optional edge first reaches it.
  const reached = new Map()
  for (let i = 0; i < queue.length; i++) {
    const { key, optional } = queue[i]
    if (!optional) required.add(key)
    if (installed.has(key)) continue
    const pkg = lockfile.packages[key]
    if (!reached.has(key)) reached.set(key, optional && check(key, pkg, true, true) === false)
    if (optional && reached.get(key)) continue
    installed.add(key)
    queue.push(...edgesOf(pkg.dependencies, false), ...edgesOf(pkg.optionalDependencies, true))
  }
  const skipped = new Set()
  const warned = new Set()
  for (const key of reached.keys()) {
    const pkg = lockfile.packages[key]
    const ok = check(key, pkg, !installed.has(key) || !required.has(key))
    if (ok === false) skipped.add(key)
    if (ok === null) warned.add(key)
  }
  const seen = new Set()
  for (let i = 0; i < starts.length; i++) {
    const key = starts[i]
    if (seen.has(key)) continue
    seen.add(key)
    const pkg = lockfile.packages[key]
    if (!installed.has(key) && pkg.optional) skipped.add(key)
    starts.push(...[...edgesOf(pkg.dependencies), ...edgesOf(pkg.optionalDependencies)].map((edge) => edge.key))
  }
  return { skipped, incompatible: warned }
}

// The keys of the snapshots left out, and of those installed although the
// host cannot run them, the host and settings being `context`'s.
export function skippedSnapshots(lockfile, context) {
  const check = createCheck(context)
  if (context.host.major >= 11) return skippedSnapshots11(lockfile, check)
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
  const incompatible = new Set()
  for (const key of picked) {
    if (skipped.has(key)) continue
    const ok = check(key, lockfile.packages[key])
    if (ok === false) skipped.add(key)
    if (ok === null) incompatible.add(key)
  }
  return { skipped, incompatible }
}
