// The node_modules tree pnpm 9, 10, 11 or 12 installs from a frozen lockfile
// with the isolated linker and --ignore-scripts, in a Vfs rooted at the
// lockfile's directory; patched still, as pnpm patches before scripts. Bins are
// not linked, though what linking does to their files is (bins.js). With
// `sizeEstimateOnly`, its directories and links alone, each package's sized
// by its version document, of which nothing is fetched but those documents.
// With `lazy`, its directories and links alone too, fetching nothing, and
// each package unpacked into it as it is asked for (lazy.js). With
// `production`, as --prod installs it (production.js): laid out from the
// lockfile it leaves, and held to the whole one.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { compareVersions } from '@preventive/upstream/semver.js'
import { Vfs } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote, refusalOf } from '../error.js'
import { checkNoModules, fold, makeDirs, mount, writeLink } from '../mount.js'
import { checkProject, productionOf } from '../project.js'
import { NO_ABOUT, REGISTRY, fetchSize, fetchingOf, tarballUrl } from '../tarball.js'
import { binReads, binTargets, hoistedBinReads, hoistedBinTargets, requiresBuild } from './bins.js'
import { buildGraph } from './graph.js'
import { hoist } from './hoist.js'
import { checkNoneDropped, hoistedBuilds, hoistedLayout, hoistedModules, mayDrop, packageIdOf, prodPackages, workspaceHoists } from './hoisted.js'
import { checkLocalOverrides, createFreshnessCheck, readDirectoryPackage, readLinked } from './local.js'
import { createPatchedCheck, skippedSnapshots } from './install.js'
import { lazyUnpacker } from './lazy.js'
import { checkFetched, fetchPackage } from './package.js'
import { checkLinks, checkOptional } from './checks.js'
import { createHook } from './hook.js'
import { productionLockfile } from './production.js'
import { listOverrides } from './overrides.js'
import { checkHost, inputsOf, manifestsOf, patchesOf, readLockfile } from './inputs.js'
import { checkProjects, pinsPnpm, workspaceNames } from './projects.js'
import { readSettings } from './settings.js'
import { checkUpToDate } from './uptodate.js'
import { checkWorkspace } from './workspace.js'
import { compose, parsedPatch, writeNode } from './write.js'

// A project inside a node_modules would be inside the tree; on macOS, a
// node_modules in any case is one.
function checkProjectsOutside(ids, folded) {
  for (const id of ids) {
    if (id.split('/').some((name) => name === 'node_modules' || (folded && fold(name) === 'node_modules'))) throw new DeptreeError('a project inside node_modules would be inside the tree', `importers[${quote(id)}]`)
  }
}

function checkLockfile(lockfile, folded) {
  if (lockfile.settings.excludeLinksFromLockfile) throw new DeptreeError('links left out of the lockfile would be left out of the tree', 'settings.excludeLinksFromLockfile')
  if (lockfile.settings.injectWorkspacePackages) throw new DeptreeError('injected workspace packages are not supported', 'settings.injectWorkspacePackages')
  if (lockfile.pnpmfileChecksum !== undefined) throw new DeptreeError('a pnpmfile\'s hooks are not run here', 'pnpmfileChecksum')
  checkProjectsOutside(Object.keys(lockfile.importers), folded)
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    if (id === '..' || id.startsWith('../')) throw new DeptreeError('a project outside the lockfile\'s directory is not supported', `importers[${quote(id)}]`)
    for (const [name, meta] of Object.entries(importer.dependenciesMeta)) {
      if (meta.injected) throw new DeptreeError('an injected dependency is not supported', `importers[${quote(id)}].dependenciesMeta[${quote(name)}]`)
    }
  }
}

// The lockfile reader holds a directory's key to it.
function checkSource(node, installed) {
  const { key, pkg } = node
  const { resolution } = pkg
  if (resolution.type === 'directory') {
    if (!installed.has(resolution.directory)) throw new DeptreeError('a dependency on a local directory is supported only where a file: override names it', quote(key))
    if (pkg.patchHash !== undefined) throw new DeptreeError('a patch to a package pnpm installs from a directory is not supported: it would be applied to the directory\'s own files, which pnpm hardlinks', quote(key))
    return
  }
  const fromRegistry = pkg.version !== undefined && packageKeyOf(key) === `${pkg.name}@${pkg.version}` && resolution.type === 'tarball'
    && resolution.path === undefined && !resolution.gitHosted && (resolution.tarball ?? tarballUrl(pkg.name, pkg.version)) === tarballUrl(pkg.name, pkg.version)
  if (!fromRegistry) throw new DeptreeError(`only packages from ${REGISTRY} are supported`, quote(key))
  if (!resolution.integrity?.startsWith('sha512-')) throw new DeptreeError('expected a sha512 integrity', quote(key))
}

const bytesOf = (files) => files.values().reduce((sum, file) => sum + file.data.length, 0)

// By name@version, as the lockfile reader gives a package's snapshots one
// resolution and manifest. With `sizeEstimateOnly`, a registry package's size
// alone, with no files or package.json; with `lazy`, nothing of one, which is
// fetched as it is unpacked. A directory is read whole all the same, and its
// size is its files'.
async function fetchAll(nodes, project, host, fetching) {
  const packages = new Map([...nodes.values()].map(({ key, pkg }) => [packageKeyOf(key), pkg]))
  const fetched = new Map()
  const fetch = (pkg, where) => (fetching.sizeEstimateOnly ? fetchSize(pkg.name, pkg.version, pkg.resolution.integrity, where, fetching) : fetchPackage(pkg, where, host.major, fetching))
  const read = (pkg, where) => {
    const got = readDirectoryPackage(project, pkg, where, host)
    return fetching.sizeEstimateOnly ? { ...got, size: bytesOf(got.files) } : got
  }
  await eachConcurrently(packages, async ([id, pkg]) => {
    if (pkg.resolution.type === 'directory') fetched.set(id, read(pkg, quote(id)))
    else if (!fetching.lazy) fetched.set(id, await fetch(pkg, quote(id)))
  }, ([id]) => quote(id))
  return fetched
}

// With `lazy`, a registry package's snapshots have no files yet, and are held
// to them as each is unpacked; `checks` are what that takes, of `checked`, the
// whole lockfile.
async function fetchNodes(nodes, checked, hook, project, host, fetching) {
  const fetched = await fetchAll(nodes, project, host, fetching)
  const checks = { lockfile: checked, hook, fresh: createFreshnessCheck(checked, host.major) }
  const byDir = new Map()
  for (const node of nodes.values()) {
    const got = fetched.get(packageKeyOf(node.key))
    if (got !== undefined) checkFetched(node, got, checks)
    byDir.set(node.dir, { ...node, files: got?.files, manifest: got?.manifest, about: got?.about ?? NO_ABOUT, size: got?.size })
  }
  return { byDir, tarballs: [...fetched.values()].filter((got) => !got.local).length, checks }
}

// pnpm hardlinks a directory package's files into each of its snapshots, so a
// file fixBin makes executable in one is so in all (a CRLF `#!` it rewrites
// stays that snapshot's own), but where pnpm builds the package or, with
// pnpm 11 and 12, packageImportMethod is neither auto nor hardlink.
function executableElsewhere(byDir, targets, packageImportMethod, major) {
  if (major >= 11 && packageImportMethod !== 'auto' && packageImportMethod !== 'hardlink') return new Map()
  const shared = [...byDir.values()].filter((node) => node.pkg.resolution.type === 'directory' && !requiresBuild(node.manifest, node.files, major))
  const byPackage = Map.groupBy(shared, (node) => packageKeyOf(node.key))
  return new Map(shared.map((node) => {
    const own = targets.get(node.dir) ?? new Set()
    const all = byPackage.get(packageKeyOf(node.key)).flatMap((other) => [...targets.get(other.dir) ?? []])
    return [node.dir, new Set(all.filter((path) => !own.has(path)))]
  }))
}

// As pnpm's symlink-dir spells it. A target may climb out of the tree, so both
// are resolved under as many dummy directories as it climbs.
function linkTarget(path, target) {
  const root = '/_'.repeat(target.split('/').filter((segment) => segment === '..').length)
  return relative(`${root}/${dirname(path)}`, `${root}/${target}`) || '.'
}

// What no project's dependencies or optionalDependencies reach is dev-only.
function reachedInProd(importers, nodes, byDir) {
  const reached = new Set(Object.values(importers)
    .flatMap(({ dependencies, optionalDependencies }) => [...Object.values(dependencies), ...Object.values(optionalDependencies)])
    .map((target) => nodes.get(target)?.dir)
    .filter((dir) => byDir.has(dir)))
  for (const dir of reached) {
    for (const child of byDir.get(dir).children.values()) if (byDir.has(child)) reached.add(child)
  }
  return reached
}

function installedOf(node, dev, patches, sizeEstimateOnly) {
  const { key, name, dir, about, size, pkg: { version, resolution, optional, patchHash } } = node
  return {
    path: dir,
    key,
    name,
    version,
    integrity: resolution.integrity,
    directory: resolution.directory,
    ...about,
    dev,
    optional,
    patch: patchHash === undefined ? undefined : { hash: patchHash, path: patches.get(patchHash).path },
    ...sizeEstimateOnly ? { size } : {},
  }
}

// Later links win: each node's children, then what is hoisted, then each
// project's direct dependencies.
function linksOf(byDir, direct, settings, projects, major, hoisting) {
  const links = new Map()
  for (const node of byDir.values()) {
    for (const [alias, dir] of node.children) if (alias !== node.name) links.set(`${node.modules}/${alias}`, dir)
    const self = node.children.get(node.name)
    if (major < 12 && byDir.has(self)) links.set(`${node.dir}/node_modules/${node.name}`, self)
  }
  for (const [path, dir] of hoist(byDir, direct, settings, projects, major, hoisting)) links.set(path, dir)
  for (const [id, children] of direct) {
    for (const [alias, dir] of children) links.set(`${id === '.' ? '' : `${id}/`}node_modules/${alias}`, dir)
  }
  return links
}

// The import methods with which each copy of a package is its own.
const COPYING = new Set(['copy', 'clone', 'clone-or-copy'])

// The hoisted layout of pnpm 10 and 11 (hoisted.js): nothing but the packages
// and links, each copy a parent before what lands in its node_modules, as
// pnpm keeps only its state in node_modules/.pnpm. `fixes` are what linking
// bins does to the files, with what pnpm's build pass does to them, read once
// every package's files are at hand; with `sizeEstimateOnly` they are not
// followed, nor with `lazy` but where a package unpacked needs them. `builds`
// tells, where any patch is configured, what the build pass builds; `reads`
// the packages the fixes read the files of (hoistedBinReads). `lockfile` is
// the one the tree is laid out from, and `checked` the whole one.
async function buildHoisted({ lockfile, checked, settings, host, project, hook, installed, manifests, names, patched, skipped, fetching }) {
  const { major } = host
  const since = (version) => compareVersions(host.pnpm, version) >= 0
  if (!COPYING.has(settings.packageImportMethod)) {
    throw new DeptreeError(`${quote(settings.packageImportMethod)} is not supported with the hoisted layout, which is built only where each copy of a package is its own: with copy, clone or clone-or-copy`, 'packageImportMethod')
  }
  const directories = since('11.24.0')
  const { placed, links, projects } = hoistedLayout(lockfile, { autoInstallPeers: settings.autoInstallPeers, skipped, directories, rootLinks: since('11.28.1') })
  if (since('11.28.0')) for (const [path, id] of workspaceHoists(placed, lockfile, settings, names)) links.set(path, id)
  for (const node of placed.values()) checkSource(node, installed)
  // pnpm builds where any patch is configured, though scripts are ignored.
  const building = Object.keys(settings.patchedDependencies ?? {}).length > 0
  const hardlinks = since('10.21.0')
  const keepsModules = since('11.25.0')
  const dropping = building && hardlinks && !keepsModules ? mayDrop(placed) : new Map()
  if (fetching.sizeEstimateOnly) checkNoneDropped(dropping, host.pnpm)
  const { byDir, tarballs, checks } = await fetchNodes(placed, checked, hook, project, host, fetching)
  const linked = readLinked(links, byDir, manifests, project)
  const prod = prodPackages(lockfile, skipped, directories)
  const dev = (node) => !prod.has(packageIdOf(node.key, node.pkg, directories))
  const builds = building ? (node) => node.pkg.patchHash !== undefined || requiresBuild(node.manifest, node.files, major) : undefined
  const idOf = since('11.23.0') ? (key) => packageIdOf(key, lockfile.packages[key], directories) : (key) => key
  const changesOf = (node) => parsedPatch(patched, node.pkg.patchHash).parsed
  const builtOf = (built) => hoistedBuilds(byDir, new Set(projects), built, { hardlinks, keepsModules, idOf, changesOf, pnpm: host.pnpm })
  const fixes = () => {
    const built = building ? builtOf(builds) : []
    const targets = hoistedBinTargets({ nodes: byDir, projects: new Map([...manifests, ...linked]), modules: hoistedModules(byDir, links, projects, manifests, lockfile), builds: built, hardlinks, keepsModules, idOf, major })
    return { targets, executable: new Map() }
  }
  // With lazy, those that may drop a node_modules are fetched with the tree.
  const early = dropping.size === 0 ? undefined : { nodes: [...byDir.values()].filter((node) => dropping.has(node.key)), check: () => builtOf((node) => dropping.has(node.key) && builds(node)) }
  return { byDir, links, fixes, reads: () => hoistedBinReads({ nodes: byDir, building, packages: lockfile.packages }), builds, early, tarballs, dev, checks }
}

// The isolated layout: each package in node_modules/.pnpm, linked from what
// needs it and where it is hoisted; `fixes` as buildHoisted's, and `reads`
// the packages they read the files of (binReads).
async function buildIsolated({ lockfile, checked, settings, host, project, hook, installed, manifests, names, skipped, fetching }) {
  const { major } = host
  const { nodes, direct, hoisting } = await buildGraph(lockfile, skipped, settings.virtualStoreDirMaxLength, major)
  for (const node of nodes.values()) checkSource(node, installed)
  const { byDir, tarballs, checks } = await fetchNodes(nodes, checked, hook, project, host, fetching)
  const links = linksOf(byDir, direct, settings, names, major, hoisting)
  const linked = readLinked(links, byDir, manifests, project)
  const prod = reachedInProd(lockfile.importers, nodes, byDir)
  const dev = (node) => !prod.has(node.dir)
  const linking = {
    nodes: byDir,
    projects: new Map([...manifests, ...linked]),
    direct,
    links,
    publicHoist: settings.publicHoistPattern?.length > 0,
    building: Object.keys(settings.patchedDependencies ?? {}).length > 0,
    peers: settings.autoInstallPeers,
    major,
  }
  const fixes = () => {
    const targets = binTargets(linking)
    return { targets, executable: executableElsewhere(byDir, targets, settings.packageImportMethod, major) }
  }
  return { byDir, links, fixes, reads: () => binReads(linking), tarballs, dev, checks }
}

export async function buildPnpmTree(options) {
  const { project, host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const fetching = fetchingOf(options ?? {})
  if (fetching.sizeEstimateOnly && into !== undefined) throw new TypeError('vfs is not taken with sizeEstimateOnly, whose tree has no files to mount')
  if (fetching.lazy && into !== undefined) throw new TypeError('vfs is not taken with lazy, whose tree is unpacked a package at a time')
  const production = productionOf(options ?? {})
  if (project !== undefined) checkProject(project)
  const machine = checkHost(given)
  const folded = machine.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  const inputs = inputsOf(options)
  const { lockfile, env } = readLockfile(inputs.lockfile)
  if (!('.' in lockfile.importers)) throw new DeptreeError('expected the root project, whose package.json holds settings', 'importers')
  // Before the project is read for any importer: none leads out of it.
  checkLockfile(lockfile, folded)
  const { manifests, pnpm, major, workspace } = manifestsOf(inputs, lockfile, given.pnpm)
  // Again with the projects given that the lockfile has no importer for.
  checkProjectsOutside(Object.keys(lockfile.importers), folded)
  const host = { pnpm, major, ...machine }
  // The env document locks config dependencies, refused, and the pnpm a project
  // pins, which leaves the tree as it is.
  if (env !== undefined && major < 11) throw new DeptreeError('the env document pnpm 11 writes is not supported', 'env')
  if (env !== undefined && Object.keys(env.importers['.'].configDependencies).length > 0) throw new DeptreeError('config dependencies are not supported', 'env.importers["."].configDependencies')
  // As pnpm 9, 10 and 11 write the lockfile's own directory.
  const empty = major >= 12 ? Object.keys(lockfile.packages).find((key) => packageKeyOf(key).endsWith('@file:')) : undefined
  if (empty !== undefined) throw new DeptreeError('pnpm 12 refuses as broken a lockfile with `file:` and an empty path', quote(empty))
  const settings = readSettings({ workspace, npmrc: inputs.npmrc, manifest: manifests.get('.'), major, pinned: pinsPnpm(manifests.get('.'), host.pnpm) })
  checkWorkspace(Object.keys(lockfile.importers), settings.packages, major)
  const overrides = listOverrides(settings.overrides, settings.catalogs, major)
  const installed = checkLocalOverrides(overrides, project)
  const patched = await checkUpToDate(lockfile, settings, overrides, patchesOf(inputs, settings.patchedDependencies), major)
  const hook = createHook({ overrides, ignored: settings.ignoredOptionalDependencies, major })
  checkProjects(lockfile, manifests, { hook, host, settings, env })
  checkOptional(lockfile)
  const names = settings.hoistWorkspacePackages ? workspaceNames(manifests) : new Map()
  const { walked, installing } = production ? productionLockfile(lockfile, { ...host, resolvePeersFromWorkspaceRoot: settings.resolvePeersFromWorkspaceRoot }) : { walked: lockfile, installing: lockfile }
  const { skipped, incompatible } = skippedSnapshots(walked, { host, settings })
  const hoisted = settings.nodeLinker === 'hoisted'
  const { byDir, links, fixes, reads, builds, early, tarballs, dev, checks } = await (hoisted ? buildHoisted : buildIsolated)({ lockfile: installing, checked: lockfile, settings, host, project, hook, installed, manifests, names, patched, skipped, fetching })
  const laidOut = fetching.sizeEstimateOnly || fetching.lazy
  const { targets, executable } = laidOut ? { targets: new Map(), executable: new Map() } : fixes()

  const vfs = new Vfs()
  if (!hoisted) makeDirs(vfs, 'node_modules/.pnpm')
  const stats = { projects: manifests.size, snapshots: Object.keys(lockfile.packages).length, installed: byDir.size, skipped: skipped.size, incompatible: incompatible.size, tarballs, patched: [...byDir.values()].filter((node) => node.pkg.patchHash !== undefined).length, files: 0, bytes: 0, links: links.size }
  const listed = []
  const composing = { major, checkPatched: createPatchedCheck({ host, settings }) }
  // Each node is let go once written, and a package's files with its last.
  // With `sizeEstimateOnly`, its directory alone is made, and its size
  // counted; with `lazy`, its directory alone, and the node is kept to unpack.
  for (const node of byDir.values()) {
    if (!fetching.lazy) byDir.delete(node.dir)
    try {
      writeNode(vfs, node.dir, laidOut ? new Map() : compose(node, patched, { targets: targets.get(node.dir) ?? new Set(), executable: executable.get(node.dir) ?? new Set() }, composing), stats)
    } catch (error) {
      throw refusalOf(error, quote(node.key))
    }
    if (fetching.sizeEstimateOnly) stats.bytes += node.size ?? 0
    listed.push(installedOf(node, dev(node), patched, fetching.sizeEstimateOnly))
  }
  for (const [path, target] of links) {
    try {
      writeLink(vfs, path, linkTarget(path, target))
    } catch (error) {
      throw new DeptreeError(`cannot be linked: ${error.message}`, quote(path), { cause: error })
    }
  }
  checkLinks(vfs, links)
  const tree = mount(vfs, into, folded)
  if (!fetching.lazy) return { vfs: tree, stats, installed: listed }
  const entryOf = (node) => installedOf(node, dev(node), patched, false)
  return { vfs: tree, stats, installed: listed, unpack: await lazyUnpacker({ vfs: tree, byDir, stats, fixes, reads, builds, early, checks, patched, composing, entryOf, fetching, folded }) }
}
