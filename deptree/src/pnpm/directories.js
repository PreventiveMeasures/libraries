// Each directory snapshot a project reaches, held to the directory's
// package.json as the read-package hook has it, by the check pnpm 11 makes
// from 11.28.7 before a frozen install (@pnpm/lockfile.verification's
// localDirectoryDepIsUpToDate). pnpm walks from each `file:` dependency of a
// project to a directory, and on from the directory by each dependency its
// package.json asks for by `file:` or `link:`; from 11.28.10, from every
// directory a package not from a directory depends on as well, where that
// package is one a project's dependencies reach. Before 11.28.9 the walk from
// each dependency of a project is its own, and from 11.28.9 one is shared by
// them all; either takes a directory once for each set of the aliases above
// it that may be peers, by whichever path it comes to it first, as it reads
// them concurrently.
//
// For any pnpm, every path to every directory is held so too, which a
// lockfile pnpm writes always passes: what pnpm may install all the same is
// refused. pnpm 12 holds a directory otherwise as well (local.js).

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { compareVersions, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { own } from '../manifest.js'
import { KINDS, specPath } from './frozen.js'
import { manifestAt } from './local.js'
import { catalogEntry, catalogOf, validForOldPackages } from './overrides.js'

const TARBALL = /\.(?:tgz|tar\.gz|tar|tar\.bz2|tbz2|tbz)$/u
// A path alone, as pnpm's local resolver reads one.
const BARE_PATH = /^(?:[./]|~\/)/u
const keysOf = (deps) => Object.keys(deps ?? {})

// refIsLocalDirectory, of a specifier or of a key's package.
const isDirectorySpec = (spec) => spec.startsWith('file:') && !TARBALL.test(spec.toLowerCase())
function filePathOf(key) {
  const at = packageKeyOf(key).indexOf('@file:', 1)
  return at === -1 ? undefined : packageKeyOf(key).slice(at + '@file:'.length)
}

// resolveFromCatalog: the catalog's specifier, the one given where it names
// no catalog, or undefined where pnpm finds the catalog misconfigured.
function fromCatalog(catalogs, alias, spec) {
  const catalog = catalogOf(spec)
  if (catalog === undefined) return spec
  const found = catalogEntry(catalogs, catalog, alias)
  if (found === undefined || catalogOf(found) !== undefined || ['link', 'file'].includes(found.split(':')[0])) return undefined
  return found
}

// getPeerSet: the peers but those that are the package itself or its
// optional dependencies, and `others`; an optional one in
// peerDependenciesMeta alone at `*`.
function peersOf(read, others, where) {
  const peers = new Map()
  if (read.peerDependencies == null && read.peerDependenciesMeta == null) return peers
  const ownDeps = new Set([...(read.name == null ? [] : [read.name]), ...others, ...keysOf(read.optionalDependencies)])
  for (const [name, range] of Object.entries(read.peerDependencies ?? {})) if (!ownDeps.has(name)) peers.set(name, { range, optional: false })
  for (const [name, meta] of Object.entries(read.peerDependenciesMeta ?? {})) {
    if (meta === null) throw new DeptreeError(`its peerDependenciesMeta has null for ${quote(name)}, which pnpm 11 fails on`, where)
    if (ownDeps.has(name) || meta?.optional !== true) continue
    peers.set(name, { range: peers.get(name)?.range ?? '*', optional: true })
  }
  return peers
}

// recordedPeersMatch: each peer not among its dependencies is recorded, and
// each recorded is one of its peers, of its range and optional or not.
function peersDiffer(read, pkg, catalogs, where) {
  const declared = peersOf(read, [], where)
  for (const name of peersOf(read, keysOf(read.dependencies), where).keys()) {
    if (!Object.hasOwn(pkg.peerDependencies, name)) return `its peer ${quote(name)} is not in the lockfile`
  }
  for (const [name, recorded] of Object.entries(pkg.peerDependencies)) {
    const peer = declared.get(name)
    if (peer === undefined) return `the lockfile's peer ${quote(name)} is not one of its peers`
    if (recorded !== peer.range && recorded !== fromCatalog(catalogs, name, peer.range)) return `its peer ${quote(name)} is ${quote(peer.range)}, and ${quote(recorded)} in the lockfile`
    const optional = own(pkg.peerDependenciesMeta, name)?.optional === true
    if (peer.optional !== optional) return `its peer ${quote(name)} is ${peer.optional ? '' : 'not '}optional, and ${optional ? '' : 'not '}optional in the lockfile`
  }
  return undefined
}

// convertEnginesRuntimeToDependencies: a runtime downloaded is a dependency.
const RUNTIMES = ['node', 'deno', 'bun']
function withRuntimes(read, deps, where) {
  const runtime = read.engines?.runtime
  if (runtime == null) return deps
  const list = Array.isArray(runtime) ? runtime : [runtime]
  let added = deps
  for (const name of RUNTIMES) {
    if (own(added, name)) continue
    let item
    for (const each of list) {
      if (each == null) throw new DeptreeError('its engines.runtime lists nothing where pnpm reads a runtime, which pnpm 11 fails on', where)
      if (each.name === name) {
        item = each
        break
      }
    }
    if (item?.onFail === 'download' && typeof item.version === 'string') added = { ...added, [name]: `runtime:${item.version.trim()}` }
  }
  return added
}

// prepareDependencyManifest, then getNonDevWantedDependencies: a dependency
// that is a peer too is left to the peer where pnpm installs peers or one
// above provides it, and a bundled one is left out.
function childrenOf(ctx, read, scope, where) {
  let deps = read.dependencies
  if (deps && read.peerDependencies) {
    const shadowed = new Set(keysOf(read.peerDependencies).filter((peer) => (ctx.autoInstallPeers && read.peerDependenciesMeta?.[peer]?.optional !== true) || scope.has(peer)))
    deps = Object.fromEntries(Object.entries(deps).filter(([name]) => !shadowed.has(name)))
  }
  if (ctx.runtimes) deps = withRuntimes(read, deps, where)
  const optional = read.optionalDependencies ?? {}
  const invalid = [...keysOf(deps), ...keysOf(optional)].find((alias) => !validForOldPackages(alias))
  if (invalid !== undefined) throw new DeptreeError(`it depends on ${quote(invalid)}, which is no package name, and which pnpm 11 fails on`, where)
  let bundled = read.bundledDependencies ?? read.bundleDependencies
  if (bundled === true) bundled = keysOf(deps)
  const left = new Set(Array.isArray(bundled) ? bundled : [])
  return Object.entries({ ...optional, ...deps }).filter(([alias]) => !left.has(alias)).map(([alias, spec]) => ({ alias, spec, optional: Boolean(own(optional, alias)) }))
}

// childIsUpToDate, for what is not asked for by `link:`, `file:` or
// `workspace:`, as lockedVersionSatisfies reads it: by `npm:` another
// package, and a range only where it is one, a tag or another selector held
// to the name alone. A link pnpm takes for no package, and refuses even as
// it wrote it, as it does for a path alone an override gives; held to that
// path where pnpm does not walk. Any other sort of specifier, such as a git
// or tarball URL, is not supported where pnpm walks, and passed over
// elsewhere.
function registryChild(ctx, { kind, alias }, spec, to, { dir, where }) {
  if (to.startsWith('link:')) {
    if (!ctx.strict) return `${kind}.${alias} is linked to ${quote(to.slice(5))}, and pnpm 11 holds ${quote(spec)}, which is neither link: nor file:, to a package the lockfile resolves, refusing even the lockfile it writes`
    // pnpm 10 takes one an override gives from the lockfile's directory.
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
  if (validRange(wanted.range) === null) return undefined
  return typeof locked.version === 'string' && satisfies(locked.version, wanted.range, { loose: true }) ? undefined : `${kind}.${alias} resolved to ${quote(to)}, which is not in ${quote(wanted.range)}`
}

// localSpecIsUpToDate: the specifier's path is from the directory, the
// lockfile's from its own; `file:` takes a link as well.
function localChild(ctx, { kind, alias }, spec, to, { dir, where }) {
  if (spec.startsWith('workspace:')) {
    if (ctx.strict) return undefined
    throw new DeptreeError(`a workspace: dependency, ${quote(alias)}, of a directory pnpm 11 holds to the lockfile is not supported`, where)
  }
  const path = to.startsWith('link:') ? to.slice(5) : spec.startsWith('file:') ? filePathOf(to) : undefined
  if (path === undefined || specPath(dir, spec.slice(5), where) !== specPath('.', path, where)) return `${kind}.${alias} is ${quote(to)} in the lockfile, which is not where ${quote(spec)} leads`
  return undefined
}

// A dependency the snapshot does not have: an optional one may be left out,
// as a frozen install lets it go unresolved, but not for a dependency; and
// one that is an optional peer too, where `ctx.drops` has it that the pnpm
// leaves that out (package.js).
function missing(ctx, { kind, alias, optional }, pkg, read) {
  if (optional ? own(pkg.dependencies, alias) === undefined : ctx.drops?.(read, alias)) return undefined
  const other = optional ? 'dependencies' : 'optionalDependencies'
  return own(pkg[other], alias) === undefined ? `${kind}.${alias} is not in the lockfile` : `${kind}.${alias} is among the lockfile's ${other}`
}

// Where pnpm walks, as it refuses; otherwise as no lockfile it writes is,
// though it may not walk that path, or come to the directory by another
// first.
function outdated(why, { pnpm, strict }, where) {
  if (strict) return new DeptreeError(`the lockfile is not up to date with its package.json, as no lockfile pnpm writes is, though a frozen install of pnpm ${pnpm} may take it: ${why}`, where)
  return new DeptreeError(`the lockfile is not up to date with its package.json, which a frozen install of pnpm ${pnpm} refuses: ${why}`, where)
}

// The dependencies of a directory's snapshot, each held as childIsUpToDate
// holds it; one asked for by `file:` to a directory is walked into, with the
// snapshot's own dependencies in scope.
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

// The package.json as the hook has it for the directory, a path an override
// gives written from it; or, `plain`, as it has it for any package.
function readOf(ctx, key, dir, plain = false) {
  const reads = plain ? ctx.plain : ctx.reads
  if (!reads.has(dir)) reads.set(dir, ctx.hook(manifestAt(ctx.project, dir, quote(key)), `${quote(packageKeyOf(key))}: package.json`, plain ? {} : { dir }))
  return reads.get(dir)
}

// localDirectoryDepIsUpToDate of one snapshot, in `scope`, the aliases above
// it. One reached again with the same of them `ctx.keyOf` takes is passed.
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

// pnpm takes a snapshot once for each set of the aliases above it that are
// its peers or any the lockfile records. What the walk from it then holds
// turns only on those above it that are peers of a directory, so a walk
// that takes it once for each set of those holds every path pnpm may take.
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
// depends on, with every package above it and the aliases those depend by.
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

// Where the walk starts for a project: each directory a dependency of it
// is, in the scope of its aliases; then each other a dependency reaches, in
// that of the aliases above it too.
function startsOf(ctx, { manifest, importer, where }) {
  const scope = new Set(KINDS.flatMap((kind) => keysOf(manifest[kind])))
  const starts = []
  for (const kind of KINDS) {
    for (const [alias, to] of Object.entries(importer[kind])) {
      const spec = own(manifest[kind], alias)
      const path = filePathOf(to)
      if (!spec || to.startsWith('link:') || !(isDirectorySpec(importer.specifiers[alias] ?? '') || (path !== undefined && isDirectorySpec(`file:${path}`)))) continue
      if (ctx.pnpmWalks && spec.startsWith('workspace:') && !/^workspace:(?:[./\\]|~[/\\]|[A-Za-z]:)/u.test(spec)) {
        throw new DeptreeError(`the lockfile is not up to date with this package.json, which a frozen install of pnpm ${ctx.pnpm} refuses: the workspace dependency ${quote(alias)} is not injected, and the lockfile resolves it to ${quote(to)}`, where)
      }
      starts.push({ key: to, scope, direct: true })
    }
  }
  ctx.nested ??= nestedOf(ctx.packages)
  const reached = new Set(KINDS.flatMap((kind) => Object.values(importer[kind])))
  for (const { key, above, aliases } of ctx.nested) {
    if (reached.has(key) || [...above].some((parent) => reached.has(parent))) starts.push({ key, scope: new Set([...aliases, ...scope]), direct: false })
  }
  return starts
}

// The check of a project, its package.json as the hook has it, against its
// importer: first as pnpm 11 walks from 11.28.7, or by `fresh`, pnpm 12's
// check (local.js), then every path. Only the directories `file:` overrides
// name, `installed`, are read, through the hook, package extensions and all.
export function createDirectoryCheck(lockfile, { host, hook, project, installed, settings, fresh, drops }) {
  const since = (version) => compareVersions(host.pnpm, version) >= 0
  const pnpmWalks = host.major === 11 && since('11.28.7')
  const { packages } = lockfile
  const ctx = {
    packages, hook, project, installed, drops, pnpm: host.pnpm, pnpmWalks, runtimes: pnpmWalks, autoInstallPeers: settings.autoInstallPeers, catalogs: settings.catalogs ?? {},
    recordedPeers: new Set(Object.values(packages).flatMap((pkg) => keysOf(pkg.peerDependencies))), reads: new Map(), plain: new Map(),
  }
  const keyOf = keyings(ctx)
  return (manifest, importer, where) => {
    const starts = startsOf(ctx, { manifest, importer, where })
    if (pnpmWalks) {
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
