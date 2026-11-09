// pnpm 11's check, from 11.28.7, of each directory snapshot a project reaches
// against the directory's package.json (localDirectoryDepIsUpToDate), and a
// stricter walk of every path for any pnpm, which each lockfile pnpm writes passes.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { compareVersions, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { own } from '../manifest.js'
import { KINDS, specPath } from './frozen.js'
import { manifestAt } from './local.js'
import { catalogEntry, catalogOf, validForOldPackages } from './overrides.js'

const TARBALL = /\.(?:tgz|tar\.gz|tar|tar\.bz2|tbz2|tbz)$/u
const BARE_PATH = /^(?:[./]|~\/)/u
const RUNTIMES = new Set(['node', 'deno', 'bun'])
const keysOf = (deps) => Object.keys(deps ?? {})

function filePathOf(key) {
  const at = packageKeyOf(key).indexOf('@file:', 1)
  return at === -1 ? undefined : packageKeyOf(key).slice(at + '@file:'.length)
}
const isDirectoryPath = (path) => path !== undefined && !TARBALL.test(path.toLowerCase())

// Undefined where pnpm finds the catalog misconfigured.
function fromCatalog(catalogs, alias, spec) {
  const catalog = catalogOf(spec)
  if (catalog === undefined) return spec
  const found = catalogEntry(catalogs, catalog, alias)
  if (found === undefined || catalogOf(found) !== undefined || ['link', 'file'].includes(found.split(':')[0])) return undefined
  return found
}

// getPeerSet, leaving out `others` too: an optional peer only in
// peerDependenciesMeta is one at `*`.
function peersOf(read, others, where) {
  const peers = new Map()
  const ownDeps = new Set([...(read.name == null ? [] : [read.name]), ...others, ...keysOf(read.optionalDependencies)])
  for (const [name, range] of Object.entries(read.peerDependencies ?? {})) if (!ownDeps.has(name)) peers.set(name, { range, optional: false })
  for (const [name, meta] of Object.entries(read.peerDependenciesMeta ?? {})) {
    if (meta === null) throw new DeptreeError(`its peerDependenciesMeta has null for ${quote(name)}, which pnpm 11 fails on`, where)
    if (!ownDeps.has(name) && meta?.optional === true) peers.set(name, { range: peers.get(name)?.range ?? '*', optional: true })
  }
  return peers
}

// recordedPeersMatch.
function peersDiffer(read, pkg, catalogs, where) {
  const declared = peersOf(read, [], where)
  const unrecorded = [...peersOf(read, keysOf(read.dependencies), where).keys()].find((name) => !Object.hasOwn(pkg.peerDependencies, name))
  if (unrecorded !== undefined) return `its peer ${quote(unrecorded)} is not in the lockfile`
  for (const [name, recorded] of Object.entries(pkg.peerDependencies)) {
    const peer = declared.get(name)
    if (peer === undefined) return `the lockfile's peer ${quote(name)} is not one of its peers`
    if (recorded !== peer.range && recorded !== fromCatalog(catalogs, name, peer.range)) return `its peer ${quote(name)} is ${quote(peer.range)}, and ${quote(recorded)} in the lockfile`
    const optional = own(pkg.peerDependenciesMeta, name)?.optional === true
    if (peer.optional !== optional) return `its peer ${quote(name)} is ${peer.optional ? '' : 'not '}optional, and ${optional ? '' : 'not '}optional in the lockfile`
  }
  return undefined
}

// getNonDevWantedDependencies of prepareDependencyManifest: a dependency that
// is a peer pnpm installs or one above provides is left to the peer.
function childrenOf(ctx, read, scope, where) {
  let deps = read.dependencies
  if (deps && read.peerDependencies) {
    const shadowed = new Set(keysOf(read.peerDependencies).filter((peer) => (ctx.autoInstallPeers && read.peerDependenciesMeta?.[peer]?.optional !== true) || scope.has(peer)))
    deps = Object.fromEntries(Object.entries(deps).filter(([name]) => !shadowed.has(name)))
  }
  const runtime = [read.engines?.runtime ?? []].flat().find((item) => RUNTIMES.has(item?.name) && item.onFail === 'download' && typeof item.version === 'string' && !own(deps, item.name))
  if (!ctx.strict && runtime !== undefined) throw new DeptreeError(`a ${runtime.name} runtime pnpm 11 would hold it to is not supported`, where)
  const optional = read.optionalDependencies ?? {}
  const invalid = [...keysOf(deps), ...keysOf(optional)].find((alias) => !validForOldPackages(alias))
  if (invalid !== undefined) throw new DeptreeError(`it depends on ${quote(invalid)}, which is no package name, and which pnpm 11 fails on`, where)
  let bundled = read.bundledDependencies ?? read.bundleDependencies
  if (bundled === true) bundled = keysOf(deps)
  const left = new Set(Array.isArray(bundled) ? bundled : [])
  return Object.entries({ ...optional, ...deps }).filter(([alias]) => !left.has(alias)).map(([alias, spec]) => ({ alias, spec, optional: Boolean(own(optional, alias)) }))
}

// lockedVersionSatisfies, which checks only a range strict semver reads; the
// strict walk checks a loose one too. pnpm refuses even the link it wrote for a
// path alone an override gives; pnpm 10 reads that path from the lockfile's.
function registryChild(ctx, { kind, alias }, spec, to, { dir, where }) {
  if (to.startsWith('link:')) {
    if (!ctx.strict) return `${kind}.${alias} is linked to ${quote(to.slice(5))}, and pnpm 11 holds ${quote(spec)}, which is neither link: nor file:, to a package the lockfile resolves, refusing even the lockfile it writes`
    return BARE_PATH.test(spec) && [dir, '.'].some((base) => specPath(base, spec, where) === to.slice(5)) ? undefined : `${kind}.${alias} is linked to ${quote(to.slice(5))}, which is not where ${quote(spec)} leads`
  }
  let wanted = { name: alias, range: spec }
  if (spec.startsWith('npm:')) {
    const raw = spec.slice('npm:'.length)
    const at = raw.lastIndexOf('@')
    wanted = at <= 0 ? { name: raw, range: '*' } : { name: raw.slice(0, at), range: raw.slice(at + 1) }
  } else if (valid(spec, { loose: true }) === null && validRange(spec, { loose: true }) === null && encodeURIComponent(spec) !== spec) {
    if (ctx.strict) return undefined
    throw new DeptreeError(`${kind}.${alias} is ${quote(spec)}, which is no version, range or tag, and a directory's dependency of another sort that pnpm 11 holds to the lockfile is not supported`, where)
  }
  const locked = ctx.packages[to]
  if (locked.name !== wanted.name) return `${kind}.${alias} resolved to ${quote(to)}, which is not ${quote(wanted.name)}`
  if (validRange(wanted.range, { loose: ctx.strict === true }) === null) return undefined
  return typeof locked.version === 'string' && satisfies(locked.version, wanted.range, { loose: true }) ? undefined : `${kind}.${alias} resolved to ${quote(to)}, which is not in ${quote(wanted.range)}`
}

// localSpecIsUpToDate: the specifier's path is read from the directory.
function localChild(ctx, { kind, alias }, spec, to, { dir, where }) {
  if (spec.startsWith('workspace:')) {
    if (ctx.strict) return undefined
    throw new DeptreeError(`a workspace: dependency, ${quote(alias)}, of a directory pnpm 11 holds to the lockfile is not supported`, where)
  }
  const path = to.startsWith('link:') ? to.slice(5) : spec.startsWith('file:') ? filePathOf(to) : undefined
  if (path === undefined || specPath(dir, spec.slice(5), where) !== specPath('.', path, where)) return `${kind}.${alias} is ${quote(to)} in the lockfile, which is not where ${quote(spec)} leads`
  return undefined
}

// A frozen install lets an optional one go unresolved, and `ctx.drops` says
// where pnpm leaves out one that is an optional peer too (package.js).
function missing(ctx, { kind, alias, optional }, pkg, read) {
  if (optional ? own(pkg.dependencies, alias) === undefined : ctx.drops?.(read, alias)) return undefined
  const other = optional ? 'dependencies' : 'optionalDependencies'
  return own(pkg[other], alias) === undefined ? `${kind}.${alias} is not in the lockfile` : `${kind}.${alias} is among the lockfile's ${other}`
}

function outdated(why, { pnpm, strict }, where) {
  if (strict) return new DeptreeError(`the lockfile is not up to date with its package.json, as no lockfile pnpm writes is, though a frozen install of pnpm ${pnpm} may take it: ${why}`, where)
  return new DeptreeError(`the lockfile is not up to date with its package.json, which a frozen install of pnpm ${pnpm} refuses: ${why}`, where)
}

function walkChildren(ctx, { key, pkg, dir, read }, scope, visited) {
  const where = quote(key)
  const children = childrenOf(ctx, read, scope, where)
  const expected = new Set([...children.map(({ alias }) => alias), ...peersOf(read, [], where).keys(), ...keysOf(read.peerDependencies)])
  for (const kind of ['dependencies', 'optionalDependencies']) {
    const unasked = keysOf(pkg[kind]).find((name) => !expected.has(name))
    if (unasked !== undefined) throw outdated(`${kind}.${unasked} is not one it asks for`, ctx, where)
  }
  const inner = new Set([...scope, ...keysOf(pkg.dependencies), ...keysOf(pkg.optionalDependencies)])
  for (const child of children) {
    const dep = { ...child, kind: child.optional ? 'optionalDependencies' : 'dependencies' }
    const to = own(pkg[dep.kind], child.alias)
    const spec = to === undefined ? undefined : fromCatalog(ctx.catalogs, child.alias, child.spec)
    const local = spec !== undefined && /^(?:link|file|workspace):/u.test(spec)
    const why = to === undefined ? missing(ctx, dep, pkg, read)
      : spec === undefined ? `${dep.kind}.${child.alias}, ${quote(child.spec)}, names no catalog entry pnpm takes`
      : (local ? localChild : registryChild)(ctx, dep, spec, to, { dir, where })
    if (why !== undefined) throw outdated(why, ctx, where)
    if (local && !to.startsWith('link:')) walk(ctx, to, inner, visited)
  }
}

// Hooked with the directory as `dir`, so a path an override gives is read
// from it; `plain`, as for any package.
function readOf(ctx, key, dir, plain = false) {
  const reads = plain ? ctx.plain : ctx.reads
  if (!reads.has(dir)) reads.set(dir, ctx.hook(manifestAt(ctx.project, dir, quote(key)), `${quote(packageKeyOf(key))}: package.json`, plain ? {} : { dir }))
  return reads.get(dir)
}

// `scope` is the aliases above the snapshot; it is passed when reached again
// with the same `ctx.keyOf` of them.
function walk(ctx, key, scope, visited) {
  const pkg = ctx.packages[key]
  if (pkg.resolution.type !== 'directory') return
  const dir = pkg.resolution.directory
  if (!ctx.installed.has(dir)) throw new DeptreeError('a dependency on a local directory is supported only where a file: override names it', quote(key))
  const read = readOf(ctx, key, dir)
  const taken = ctx.keyOf(read, scope)
  const scopes = visited.get(key) ?? new Set()
  if (scopes.has(taken)) return
  visited.set(key, scopes.add(taken))
  const why = peersDiffer(read, pkg, ctx.catalogs, quote(key))
  if (why !== undefined) throw outdated(why, ctx, quote(key))
  walkChildren(ctx, { key, pkg, dir, read }, scope, visited)
}

// pnpm keys a visit by the aliases above that are its peers or any recorded;
// keying by those that are any directory's peers holds every path it may take.
const among = (scope, names) => [...names].filter((name) => scope.has(name)).sort().join('\0')
function keyings(ctx) {
  let every
  const everyPeer = () => {
    every ??= new Set([...ctx.recordedPeers, ...Object.entries(ctx.packages)
      .filter(([, pkg]) => pkg.resolution.type === 'directory' && ctx.installed.has(pkg.resolution.directory))
      .flatMap(([key, pkg]) => keysOf(readOf(ctx, key, pkg.resolution.directory).peerDependencies))])
    return every
  }
  return {
    pnpm: (read, scope) => among(scope, new Set([...keysOf(read.peerDependencies), ...ctx.recordedPeers])),
    every: (read, scope) => among(scope, everyPeer()),
  }
}

// findNestedDirectoryPackages: each directory a package not from a directory
// depends on, with the packages above it and the aliases they depend by.
function nestedOf(packages) {
  const isDirectory = (key) => packages[key].resolution.type === 'directory'
  const edges = (pkg) => [...Object.entries(pkg.dependencies), ...Object.entries(pkg.optionalDependencies)].filter(([, to]) => !to.startsWith('link:'))
  const nested = new Set()
  const parents = new Map()
  for (const [key, pkg] of Object.entries(packages)) {
    for (const [, to] of edges(pkg)) {
      if (!isDirectory(key) && to.includes('file:') && isDirectory(to)) nested.add(to)
      if (!parents.has(to)) parents.set(to, [])
      parents.get(to).push(key)
    }
  }
  return [...nested].map((key) => {
    const above = new Set()
    const queue = [key]
    while (queue.length > 0) {
      for (const parent of parents.get(queue.pop()) ?? []) {
        if (parent === key || above.has(parent)) continue
        above.add(parent)
        queue.push(parent)
      }
    }
    return { key, above, aliases: [...above].flatMap((parent) => edges(packages[parent]).map(([alias]) => alias)) }
  })
}

// Each directory a project depends on by `file:`, then each a dependency
// reaches through a package not from a directory.
function startsOf(ctx, manifest, importer) {
  const scope = new Set(KINDS.flatMap((kind) => keysOf(manifest[kind])))
  const starts = []
  for (const kind of KINDS) {
    for (const [alias, to] of Object.entries(importer[kind])) {
      const spec = importer.specifiers[alias] ?? ''
      const direct = (spec.startsWith('file:') && isDirectoryPath(spec)) || isDirectoryPath(filePathOf(to))
      if (own(manifest[kind], alias) && !to.startsWith('link:') && direct) starts.push({ key: to, scope, direct: true })
    }
  }
  ctx.nested ??= nestedOf(ctx.packages)
  const reached = new Set(KINDS.flatMap((kind) => Object.values(importer[kind])))
  for (const { key, above, aliases } of ctx.nested) {
    if (reached.has(key) || [...above].some((parent) => reached.has(parent))) starts.push({ key, scope: new Set([...aliases, ...scope]), direct: false })
  }
  return starts
}

// `fresh` is pnpm 12's own check (local.js), run first for its message.
export function createDirectoryCheck(lockfile, { host, hook, project, installed, settings, fresh, drops }) {
  const since = (version) => compareVersions(host.pnpm, version) >= 0
  const { packages } = lockfile
  const ctx = {
    packages, hook, project, installed, drops, pnpm: host.pnpm, autoInstallPeers: settings.autoInstallPeers, catalogs: settings.catalogs ?? {},
    recordedPeers: new Set(Object.values(packages).flatMap((pkg) => keysOf(pkg.peerDependencies))), reads: new Map(), plain: new Map(),
  }
  const keyOf = keyings(ctx)
  return (manifest, importer) => {
    const starts = startsOf(ctx, manifest, importer)
    if (host.major === 11 && since('11.28.7')) {
      // Before 11.28.9 each dependency of a project has a walk of its own.
      const shared = new Map()
      const walking = { ...ctx, keyOf: keyOf.pnpm }
      for (const { key, scope, direct } of starts) {
        if (direct || since('11.28.10')) walk(walking, key, scope, direct && !since('11.28.9') ? new Map() : shared)
      }
    }
    for (const { key, direct } of fresh === undefined ? [] : starts) {
      const { resolution } = packages[key]
      if (direct && resolution.type === 'directory' && installed.has(resolution.directory)) fresh({ key }, readOf(ctx, key, resolution.directory, true))
    }
    const every = new Map()
    const strict = { ...ctx, keyOf: keyOf.every, strict: true }
    for (const { key, scope } of starts) walk(strict, key, scope, every)
  }
}
