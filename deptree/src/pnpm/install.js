// Which snapshots a pnpm 10 frozen install leaves out: an optional one the
// host cannot run (by its os, cpu, libc or engines.node), and an optional
// one first reached, depth first from the projects, through one that is
// not installed. The first reach decides, as for pnpm
// (@pnpm/lockfile.filtering's pkgAllDeps, then @pnpm/deps.graph-builder
// checking each snapshot again), so one reached both ways is left out or
// not by which way is walked first. Anything else incompatible is
// installed with a warning, or refused under engineStrict.
//
// Projects are walked in the lockfile's order, by directory, where pnpm
// walks them in the order it finds them on disk; only a snapshot reached
// both ways can tell.
//
// pnpm 11 walks breadth first, by the kind of each edge rather than of
// each snapshot: an optional dependency the host cannot run is not taken,
// what a taken package requires is taken anyway, with a warning, and each
// reachable snapshot not taken is left out. Where an optional edge's
// package names no os, cpu or libc, it infers them from its name, as
// `@nx/nx-win32-arm64-msvc` names win32.
//
// pnpm 12 leaves out the same, but with engineStrict refuses whatever it
// installs that the host cannot run, optional mark or not, and holds a
// patched package's published engines to the host as it walks it.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// pnpm's checkList. pnpm 10 counts the exclusions over every value the
// host is taken to be, so a list of them alone takes nothing where there
// is more than one; pnpm 11 does not. pnpm 12 takes, of each value, the
// first item that names it.
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

// pnpm 11's inferPlatformFromPackageName, from the unscoped name's words.
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

// pnpm 12 drops what of a range it cannot parse, where npm's semver takes
// none of it, and reads a `-` range with an `x` as taking nothing.
function checkSure12(range, where, what = 'its engines.node') {
  if (typeof range !== 'string' || (validRange(range) !== null && !(/\s-\s/u.test(range) && /[*xX]/u.test(range)))) return
  throw new DeptreeError(`${what}, ${quote(range)}, pnpm 12 reads otherwise than npm's semver, which is not supported`, where)
}

// The Node pnpm checks engines.node against: nodeVersion, else the Node
// the root's engines.runtime pins, else the host's.
const nodeOf = ({ host, settings }) => settings.nodeVersion ?? settings.runtimeNodeVersion ?? host.node

// With engineStrict, pnpm 11 checks a patched snapshot's engines from its
// package.json, once patched, rather than from the lockfile.
const patchedLater = ({ host, settings }) => host.major >= 11 && settings.engineStrict === true

// A package.json's os, cpu or libc as pnpm's checkList reads one.
function platformList(value, where) {
  if (value == null) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  throw new DeptreeError('expected a string or a list of them', where)
}

// pnpm 12 checks only the root's engines.node, and only with engineStrict.
function checkRoot12(manifest, where, context) {
  const range = manifest.engines?.node
  if (!context.settings.engineStrict || typeof range !== 'string' || range === '') return
  const node = nodeOf(context)
  checkSure12(range, where)
  if (!takesEngine({ node: range }, node)) throw new DeptreeError(`its engines.node, ${quote(range)}, does not take Node ${node}, which engineStrict refuses`, where)
}

// A project as pnpm's packageIsInstallable holds it: a platform the host is
// not only warns, and is found first, so the engines are then not checked;
// an engines.node the host's Node is not in warns too, unless engineStrict.
export function checkProject(manifest, where, { host, settings, root }) {
  if (host.major >= 12) {
    if (root) checkRoot12(manifest, where, { host, settings })
    return
  }
  const platform = { os: platformList(manifest.os, `${where}.os`), cpu: platformList(manifest.cpu, `${where}.cpu`), libc: platformList(manifest.libc, `${where}.libc`) }
  if (!takesPlatform(platform, host, settings.supportedArchitectures)) return
  const { engines } = manifest
  if (engines == null) return
  const node = nodeOf({ host, settings })
  if (engines.pnpm && !satisfies(host.pnpm, engines.pnpm, { includePrerelease: true })) {
    throw new DeptreeError(`its engines.pnpm, ${quote(String(engines.pnpm))}, does not take pnpm ${host.pnpm}, which pnpm refuses`, where)
  }
  if (settings.engineStrict && !takesEngine(engines, node)) throw new DeptreeError(`its engines.node, ${quote(String(engines.node))}, does not take Node ${node}, which engineStrict refuses`, where)
}

// A check of one snapshot: true where the host can run it, false where it
// is optional and cannot, and null where it cannot but is installed
// anyway, which engineStrict refuses where the lockfile does not mark it
// optional, or with pnpm 12. pnpm 11 and 12 take it to be optional as the
// edge it is reached by. A patched one's engines are checked later
// (patchedLater), but pnpm 12 `walking` the lockfile holds it to its
// published ones.
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

// Where pnpm checks a patched package.json (patchedLater), it removes an
// optional package that fails from the tree already linked, also refused.
// pnpm 12 uses nodeVersion or the host's Node, not engines.runtime's.
export function createPatchedCheck(context) {
  if (!patchedLater(context)) return undefined
  const { host, settings } = context
  const node = host.major >= 12 ? settings.nodeVersion ?? host.node : nodeOf(context)
  return (manifest, where) => {
    if (manifest.engines == null) return
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

// A project's snapshots, then those of projects it links to not walked
// yet, as pnpm's toImporterDepPaths lists them.
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

// pnpm 11's filterLockfileByImportersAndEngine.
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
  const incompatible = new Set()
  for (const key of reached.keys()) {
    const ok = check(key, lockfile.packages[key], !installed.has(key) || !required.has(key))
    if (ok === false) skipped.add(key)
    if (ok === null) incompatible.add(key)
  }
  const seen = new Set(starts)
  for (const key of seen) {
    const pkg = lockfile.packages[key]
    if (!installed.has(key) && pkg.optional) skipped.add(key)
    for (const edge of [...edgesOf(pkg.dependencies), ...edgesOf(pkg.optionalDependencies)]) seen.add(edge.key)
  }
  return { skipped, incompatible }
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
