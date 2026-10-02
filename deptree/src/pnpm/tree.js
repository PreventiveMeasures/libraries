// The node_modules tree pnpm 9, 10, 11 or 12 installs from a frozen lockfile
// with the isolated linker and --ignore-scripts, in a Vfs rooted at the
// lockfile's directory; patched still, as pnpm patches before scripts. Bins are
// not linked, though what linking does to their files is (bins.js).

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { Vfs } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote, refusalOf } from '../error.js'
import { checkNoModules, checkWrite, fold, isInside, makeDirs, mount, writeLink } from '../mount.js'
import { applyPatch, parsePatch } from '../patch.js'
import { checkProject, typeOf } from '../project.js'
import { REGISTRY, tarballUrl } from '../tarball.js'
import { binTargets, checkPatchOfBins, executableMode, fixBin, requiresBuild } from './bins.js'
import { buildGraph } from './graph.js'
import { hoist } from './hoist.js'
import { checkLocalOverrides, createFreshnessCheck, readDirectoryPackage, readLinked } from './local.js'
import { createPatchedCheck, skippedSnapshots } from './install.js'
import { checkDependencies, fetchPackage } from './package.js'
import { checkLinks, checkOptional } from './checks.js'
import { createHook } from './hook.js'
import { listOverrides } from './overrides.js'
import { checkHost, inputsOf, manifestsOf, patchesOf, readLockfile } from './inputs.js'
import { checkProjects, pinsPnpm, workspaceNames } from './projects.js'
import { readSettings } from './settings.js'
import { checkUpToDate } from './uptodate.js'
import { checkWorkspace } from './workspace.js'

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

// By name@version, as the lockfile reader gives a package's snapshots one
// resolution and manifest.
async function fetchAll(nodes, project, host) {
  const packages = new Map([...nodes.values()].map(({ key, pkg }) => [packageKeyOf(key), pkg]))
  const fetched = new Map()
  await eachConcurrently(packages, async ([id, pkg]) => {
    fetched.set(id, pkg.resolution.type === 'directory' ? readDirectoryPackage(project, pkg, quote(id), host) : await fetchPackage(pkg, quote(id), host.major))
  }, ([id]) => quote(id))
  return fetched
}

async function fetchNodes(nodes, lockfile, hook, project, host) {
  const fetched = await fetchAll(nodes, project, host)
  const fresh = createFreshnessCheck(lockfile, host.major)
  const byDir = new Map()
  for (const node of nodes.values()) {
    const id = packageKeyOf(node.key)
    const got = fetched.get(id)
    got.read ??= hook(got.manifest, `${quote(id)}: package.json`)
    checkDependencies(got.manifest, got.read, node.pkg, lockfile.packages, quote(node.key))
    fresh?.(node, got.read)
    byDir.set(node.dir, { ...node, files: got.files, manifest: got.manifest })
  }
  return { byDir, tarballs: [...fetched.values()].filter((got) => !got.local).length }
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

function compose(node, patches, { targets, executable }, { major, checkPatched }) {
  const where = quote(node.key)
  let files = node.files
  const { patchHash } = node.pkg
  if (patchHash !== undefined) {
    const patch = patches.get(patchHash)
    patch.parsed ??= parsePatch(patch.text, patch.path)
    patch.applied ??= new WeakMap()
    if (!patch.applied.has(files)) patch.applied.set(files, applyPatch(files, patch.parsed, { createdMode: major >= 12 ? 0o644 : undefined }))
    files = patch.applied.get(files)
    const manifest = checkPatchOfBins(node, files, targets, where, major)
    checkPatched?.(manifest, where)
  }
  if (targets.size === 0 && executable.size === 0) return files
  files = new Map(files)
  for (const path of targets) files.set(path, fixBin(files.get(path), `${where}: ${quote(path)}`, major))
  for (const path of executable) files.set(path, { ...files.get(path), mode: executableMode(files.get(path).mode, major) })
  return files
}

function addMade(made, dir) {
  for (let at = dir; !made.has(at) && at !== '/'; at = dirname(at)) made.add(at)
}

// Only this node writes under `dir`, and the tree holds no links yet, so `made`
// knows every directory there and no write needs a look first, which costs a
// thrown error where nothing is.
function writeNode(vfs, dir, files, stats) {
  const root = `/${dir}`
  if (typeOf(vfs, root, false) !== undefined) throw new DeptreeError('would be written over with something else', quote(dir))
  const real = new Set()
  makeDirs(vfs, dir, real)
  const made = new Set([root])
  for (const [path, file] of files) {
    const at = `${root}/${path}`
    if (file.directory) {
      if (!isInside(path)) throw new DeptreeError('is not a path within the package', quote(at.slice(1)))
      makeDirs(vfs, at.slice(1), real)
      addMade(made, at)
      continue
    }
    if (made.has(at)) throw new DeptreeError('would be written over with something else', quote(at.slice(1)))
    const parent = dirname(at)
    if (!made.has(parent)) {
      makeDirs(vfs, parent.slice(1), real)
      addMade(made, parent)
    }
    vfs.writeFile(checkWrite(vfs, dir, path, real), file.data, { mode: file.mode })
    stats.files++
    stats.bytes += file.data.length
  }
}

// As pnpm's symlink-dir spells it. A target may climb out of the tree, so both
// are resolved under as many dummy directories as it climbs.
function linkTarget(path, target) {
  const climbs = target.split('/').filter((segment) => segment === '..').length
  const root = '/_'.repeat(climbs)
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

function installedOf(node, dev, patches) {
  const { key, name, dir, pkg: { version, resolution, optional, patchHash } } = node
  return {
    path: dir,
    key,
    name,
    version,
    integrity: resolution.integrity,
    directory: resolution.directory,
    dev,
    optional,
    patch: patchHash === undefined ? undefined : { hash: patchHash, path: patches.get(patchHash).path },
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

export async function buildPnpmTree(options) {
  const { project, host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
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
  const patches = patchesOf(inputs, settings.patchedDependencies)
  const patched = await checkUpToDate(lockfile, settings, overrides, patches, major)
  const hook = createHook({ overrides, ignored: settings.ignoredOptionalDependencies, major })
  checkProjects(lockfile, manifests, { hook, host, settings, env })
  checkOptional(lockfile)
  const projects = settings.hoistWorkspacePackages ? workspaceNames(manifests) : new Map()
  const { skipped, incompatible } = skippedSnapshots(lockfile, { host, settings })
  const { nodes, direct, hoisting } = await buildGraph(lockfile, skipped, settings.virtualStoreDirMaxLength, major)
  for (const node of nodes.values()) checkSource(node, installed)

  const { byDir, tarballs } = await fetchNodes(nodes, lockfile, hook, project, host)
  const links = linksOf(byDir, direct, settings, projects, major, hoisting)
  const linked = readLinked(links, byDir, manifests, project)
  const targets = binTargets({
    nodes: byDir,
    projects: new Map([...manifests, ...linked]),
    direct,
    links,
    publicHoist: settings.publicHoistPattern?.length > 0,
    building: Object.keys(settings.patchedDependencies ?? {}).length > 0,
    peers: settings.autoInstallPeers,
    major,
  })
  const executable = executableElsewhere(byDir, targets, settings.packageImportMethod, major)
  const prod = reachedInProd(lockfile.importers, nodes, byDir)

  const vfs = new Vfs()
  makeDirs(vfs, 'node_modules/.pnpm')
  const stats = { projects: manifests.size, snapshots: Object.keys(lockfile.packages).length, installed: nodes.size, skipped: skipped.size, incompatible: incompatible.size, tarballs, patched: [...nodes.values()].filter((node) => node.pkg.patchHash !== undefined).length, files: 0, bytes: 0, links: links.size }
  const listed = []
  const composing = { major, checkPatched: createPatchedCheck({ host, settings }) }
  // Each node is let go once written, and a package's files with its last.
  for (const node of byDir.values()) {
    byDir.delete(node.dir)
    try {
      writeNode(vfs, node.dir, compose(node, patched, { targets: targets.get(node.dir) ?? new Set(), executable: executable.get(node.dir) ?? new Set() }, composing), stats)
    } catch (error) {
      throw refusalOf(error, quote(node.key))
    }
    listed.push(installedOf(node, !prod.has(node.dir), patched))
  }
  for (const [path, target] of links) {
    try {
      writeLink(vfs, path, linkTarget(path, target))
    } catch (error) {
      throw new DeptreeError(`cannot be linked: ${error.message}`, quote(path), { cause: error })
    }
  }
  checkLinks(vfs, links)
  return { vfs: mount(vfs, into, folded), stats, installed: listed }
}
