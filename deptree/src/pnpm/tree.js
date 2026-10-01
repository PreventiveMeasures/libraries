// A node_modules tree as pnpm 10, 11 or 12 installs it from a frozen lockfile
// with the isolated linker, held in a Vfs rooted at the lockfile's directory:
// each package's files at node_modules/.pnpm/<its directory>/node_modules/
// <its name>, its dependencies linked beside it, the hoisted aliases in
// node_modules/.pnpm/node_modules and node_modules, and each project's
// direct dependencies in its own node_modules. Every link is relative, as
// pnpm makes them outside Windows, and a `link:` leads where the lockfile
// says whether or not anything is there: the tree holds node_modules and
// nothing else of the projects.
//
// Not written: bins and their shims (node_modules/.bin), though what
// linking them does to the files they run is (bins.js); .modules.yaml,
// .pnpm/lock.yaml and the workspace state, which are pnpm's own; and
// anything a lifecycle script would build. The tree is always the one
// `pnpm install --ignore-scripts` makes: no script is run, a project's or
// a dependency's, whatever the settings allow, and patches are applied all
// the same, as pnpm applies them before any script.
//
// Each package is fetched once, and each snapshot's files composed in
// memory — its package's, patched, bins fixed — before one write of each.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { Vfs, VfsError } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkNoModules, mount } from '../mount.js'
import { applyPatch, parsePatch } from '../patch.js'
import { REGISTRY, checkDependencies, checkManifest, fetchPackage, sameBytes, tarballUrl } from '../tarball.js'
import { binTargets, checkPatchOfBins, fixBin, requiresBuild } from './bins.js'
import { buildGraph } from './graph.js'
import { hoist } from './hoist.js'
import { checkLocalOverrides, createFreshnessCheck, readDirectoryPackage, readLinked } from './local.js'
import { createPatchedCheck, skippedSnapshots } from './install.js'
import { checkCollisions, checkLinks, checkOptional } from './checks.js'
import { createHook } from './hook.js'
import { listOverrides } from './overrides.js'
import { checkHost, inputsOf, manifestsOf, patchesOf, readLockfile } from './inputs.js'
import { checkProject } from './project.js'
import { checkProjects, pinsPnpm, workspaceNames } from './projects.js'
import { readSettings } from './settings.js'
import { checkUpToDate } from './uptodate.js'
import { checkWorkspace } from './workspace.js'

// What the lockfile holds that no tree is built for here.
function checkLockfile(lockfile) {
  if (lockfile.settings.excludeLinksFromLockfile) throw new DeptreeError('links left out of the lockfile would be left out of the tree', 'settings.excludeLinksFromLockfile')
  if (lockfile.settings.injectWorkspacePackages) throw new DeptreeError('injected workspace packages are not supported', 'settings.injectWorkspacePackages')
  if (lockfile.pnpmfileChecksum !== undefined) throw new DeptreeError('a pnpmfile\'s hooks are not run here', 'pnpmfileChecksum')
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    if (id === '..' || id.startsWith('../')) throw new DeptreeError('a project outside the lockfile\'s directory is not supported', `importers[${quote(id)}]`)
    if (id.split('/').includes('node_modules')) throw new DeptreeError('a project inside node_modules would be inside the tree', `importers[${quote(id)}]`)
    for (const [name, meta] of Object.entries(importer.dependenciesMeta)) {
      if (meta.injected) throw new DeptreeError('an injected dependency is not supported', `importers[${quote(id)}].dependenciesMeta[${quote(name)}]`)
    }
  }
}

// A package fetched here comes from the public registry, as upstream
// fetches it: its key is its name and version, and its resolution a
// tarball there with a sha512. One pnpm installs from a directory is one
// a `file:` override names, in `installed`, as local.js reads it, and is
// not patched: pnpm installs its files by hardlinks, so a patch would be
// applied to the directory's own.
function checkSource(node, installed) {
  const { key, pkg } = node
  const { resolution } = pkg
  if (resolution.type === 'directory') {
    if (packageKeyOf(key) !== `${pkg.name}@file:${resolution.directory}` || !installed.has(resolution.directory)) throw new DeptreeError('a dependency on a local directory is supported only where a file: override names it', quote(key))
    if (pkg.patchHash !== undefined) throw new DeptreeError('a patch to a package pnpm installs from a directory is not supported: it would be applied to the directory\'s own files, which pnpm hardlinks', quote(key))
    return
  }
  const fromRegistry = pkg.version !== undefined && packageKeyOf(key) === `${pkg.name}@${pkg.version}` && resolution.type === 'tarball'
    && resolution.path === undefined && !resolution.gitHosted && (resolution.tarball ?? tarballUrl(pkg.name, pkg.version)) === tarballUrl(pkg.name, pkg.version)
  if (!fromRegistry) throw new DeptreeError(`only packages from ${REGISTRY} are supported`, quote(key))
  if (!resolution.integrity?.startsWith('sha512-')) throw new DeptreeError('expected a sha512 integrity', quote(key))
}

// What a package's snapshots all have of it, and it is fetched and held to.
const PACKAGE_FIELDS = ['resolution', 'os', 'cpu', 'libc', 'hasBin', 'bundledDependencies']
const packageFields = (pkg) => JSON.stringify(PACKAGE_FIELDS.map((field) => pkg[field]))

// Each package's files and package.json, by its name and version: a
// package is fetched once however many snapshots it has, a few at a time.
// One installed from a directory is read from `project`, as npm-packlist
// picks its files.
async function fetchAll(nodes, project, major) {
  const packages = new Map()
  for (const { key, pkg } of nodes.values()) {
    const id = packageKeyOf(key)
    if (!packages.has(id)) packages.set(id, pkg)
    else if (packageFields(packages.get(id)) !== packageFields(pkg)) throw new DeptreeError(`its snapshots differ on what the package is: ${PACKAGE_FIELDS.join(', ')}`, quote(id))
  }
  const fetched = new Map()
  await eachConcurrently(packages, async ([id, pkg]) => {
    try {
      if (pkg.resolution.type === 'directory') {
        const got = readDirectoryPackage(project, pkg, quote(id), major)
        checkManifest(got.manifest, pkg, quote(id), major)
        fetched.set(id, { ...got, local: true })
      } else fetched.set(id, await fetchPackage(pkg, quote(id), major))
    } catch (error) {
      throw error instanceof DeptreeError ? error : new DeptreeError(error.message, quote(id), { cause: error })
    }
  })
  return fetched
}

// Each node with its package's files and package.json, by its directory:
// its dependencies held to the package.json, as `hook` reads it once for
// each package; and the number of tarballs fetched.
async function fetchNodes(nodes, hook, project, major, fresh) {
  const fetched = await fetchAll(nodes, project, major)
  const byDir = new Map()
  for (const node of nodes.values()) {
    const id = packageKeyOf(node.key)
    const got = fetched.get(id)
    got.read ??= hook(got.manifest, `${quote(id)}: package.json`)
    checkDependencies(got.manifest, got.read, node.pkg, quote(node.key))
    fresh?.(node, got.read)
    byDir.set(node.dir, { ...node, files: got.files, manifest: got.manifest })
  }
  return { byDir, tarballs: [...fetched.values()].filter((got) => !got.local).length }
}

// A package installed from a directory has one file for each of its
// files, hardlinked into each of its snapshots: fixBin makes it
// executable in all of them, though a CRLF `#!` line it rewrites is
// written as a file of that snapshot's own. Each snapshot has its own
// copy instead where pnpm builds the package, or, with pnpm 11 and 12,
// where packageImportMethod is other than auto or hardlink. By
// directory, the files a snapshot has made executable by another's:
// `targets` is binTargets's.
function executableElsewhere(byDir, targets, packageImportMethod, major) {
  const linked = major < 11 || packageImportMethod === 'auto' || packageImportMethod === 'hardlink'
  const shared = [...byDir.values()].filter((node) => linked && node.pkg.resolution.type === 'directory' && !requiresBuild(node.manifest, node.files, major))
  const byPackage = new Map()
  for (const node of shared) {
    const id = packageKeyOf(node.key)
    if (!byPackage.has(id)) byPackage.set(id, new Set())
    for (const path of targets.get(node.dir) ?? []) byPackage.get(id).add(path)
  }
  const executable = new Map()
  for (const node of shared) {
    const own = targets.get(node.dir) ?? new Set()
    executable.set(node.dir, new Set([...byPackage.get(packageKeyOf(node.key))].filter((path) => !own.has(path))))
  }
  return executable
}

// A snapshot's files as pnpm leaves them: its package's, the patch the
// snapshot names applied, and what linking bins does to them: fixBin run
// on `targets`, and `executable` made so. `checkPatched` is
// createPatchedCheck's.
function compose(node, patches, { targets, executable }, { major, checkPatched }) {
  const where = quote(node.key)
  let files = node.files
  const { patchHash } = node.pkg
  if (patchHash !== undefined) {
    if (!patches.has(patchHash)) throw new DeptreeError(`the patch ${patchHash} is not given`, where)
    const patch = patches.get(patchHash)
    patch.parsed ??= parsePatch(patch.text, patch.path)
    // Once for each package, whatever its snapshots.
    patch.applied ??= new WeakMap()
    if (!patch.applied.has(files)) patch.applied.set(files, applyPatch(files, patch.parsed, { createdMode: major >= 12 ? 0o644 : undefined }))
    files = patch.applied.get(files)
    const manifest = checkPatchOfBins(node, files, targets, where, major)
    checkPatched?.(manifest, where)
  }
  if (targets.size === 0 && executable.size === 0) return files
  files = new Map(files)
  for (const path of targets) files.set(path, fixBin(files.get(path), `${where}: ${quote(path)}`, major))
  for (const path of executable) files.set(path, { ...files.get(path), mode: 0o755 })
  return files
}

// Writes a file where nothing is, or the same file is: a write never
// replaces anything else. The tree holds no links yet.
function writeOnce(vfs, path, { data, mode }) {
  let there
  try {
    there = vfs.lstat(path)
  } catch (error) {
    if (!(error instanceof VfsError)) throw error
    vfs.mkdir(dirname(path), { recursive: true })
    vfs.writeFile(path, data, { mode })
    return true
  }
  if (there.type === 'file' && there.mode === mode && sameBytes(vfs.readFile(path), data)) return false
  throw new DeptreeError('would be written over with something else', quote(path.slice(1)))
}

// A link's target spelled from the directory the link is in, as pnpm's
// symlink-dir spells it; a target may climb out of the tree, so both are
// read under as many directories as it climbs.
function linkTarget(path, target) {
  const climbs = target.split('/').filter((segment) => segment === '..').length
  const root = '/_'.repeat(climbs)
  return relative(`${root}/${dirname(path)}`, `${root}/${target}`) || '.'
}

// Every link in the tree, by its path: each node's children beside it and,
// but with pnpm 12, itself inside it where it depends on itself, then what
// is hoisted, then each project's direct dependencies, which win over a
// hoisted alias.
// `byDir` is the graph by directory, and `hoisting` graph.js's.
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
  checkLockfile(lockfile)
  const { manifests, pnpm, major, workspace } = manifestsOf(inputs, lockfile, given.pnpm)
  const host = { pnpm, major, ...machine }
  // pnpm 11 locks config dependencies there, which are refused, and the
  // pnpm a project pins, which leaves the tree as it is.
  if (env !== undefined && host.major < 11) throw new DeptreeError('the env document pnpm 11 writes is not supported', 'env')
  if (env !== undefined && Object.keys(env.importers['.'].configDependencies).length > 0) throw new DeptreeError('config dependencies are not supported', 'env.importers["."].configDependencies')
  const settings = readSettings({ workspace, npmrc: inputs.npmrc, manifest: manifests.get('.'), major: host.major, pinned: pinsPnpm(manifests.get('.'), host.pnpm) })
  checkWorkspace(Object.keys(lockfile.importers), settings.packages, host.major)
  const overrides = listOverrides(settings.overrides, settings.catalogs, host.major)
  const installed = checkLocalOverrides(overrides, project)
  const patches = patchesOf(inputs, settings.patchedDependencies)
  const patched = await checkUpToDate(lockfile, settings, overrides, patches, host.major)
  const hook = createHook({ overrides, ignored: settings.ignoredOptionalDependencies, major: host.major })
  checkProjects(lockfile, manifests, { hook, host, settings, env })
  checkOptional(lockfile)
  const projects = settings.hoistWorkspacePackages ? workspaceNames(manifests) : new Map()
  const { skipped, incompatible } = skippedSnapshots(lockfile, { host, settings })
  const { nodes, direct, hoisting } = await buildGraph(lockfile, skipped, settings.virtualStoreDirMaxLength, host.major)
  for (const node of nodes.values()) checkSource(node, installed)

  const { byDir, tarballs } = await fetchNodes(nodes, hook, project, host.major, createFreshnessCheck(lockfile, host.major))
  const links = linksOf(byDir, direct, settings, projects, host.major, hoisting)
  const linked = readLinked(links, byDir, manifests, project)
  const targets = binTargets({
    nodes: byDir,
    projects: new Map([...manifests, ...linked]),
    direct,
    links,
    publicHoist: settings.publicHoistPattern?.length > 0,
    building: Object.keys(settings.patchedDependencies ?? {}).length > 0,
    peers: settings.autoInstallPeers,
    major: host.major,
  })
  const executable = executableElsewhere(byDir, targets, settings.packageImportMethod, host.major)

  const vfs = new Vfs()
  vfs.mkdir('/node_modules/.pnpm', { recursive: true })
  const stats = { projects: manifests.size, snapshots: Object.keys(lockfile.packages).length, installed: nodes.size, skipped: skipped.size, incompatible: incompatible.size, tarballs, patched: 0, files: 0, bytes: 0, links: links.size }
  const composing = { major: host.major, checkPatched: createPatchedCheck({ host, settings }) }
  // Each node is let go once written, and a package's files with its last.
  for (const node of byDir.values()) {
    byDir.delete(node.dir)
    if (node.pkg.patchHash !== undefined) stats.patched++
    try {
      vfs.mkdir(`/${node.dir}`, { recursive: true })
      for (const [path, file] of compose(node, patched, { targets: targets.get(node.dir) ?? new Set(), executable: executable.get(node.dir) ?? new Set() }, composing)) {
        if (file.directory) vfs.mkdir(`/${node.dir}/${path}`, { recursive: true })
        else if (writeOnce(vfs, `/${node.dir}/${path}`, file)) {
          stats.files++
          stats.bytes += file.data.length
        }
      }
    } catch (error) {
      if (error instanceof DeptreeError) throw error
      throw new DeptreeError(error.message, quote(node.key), { cause: error })
    }
  }
  for (const [path, target] of links) {
    try {
      vfs.mkdir(dirname(`/${path}`), { recursive: true })
      vfs.symlink(linkTarget(path, target), `/${path}`)
    } catch (error) {
      throw new DeptreeError(`cannot be linked: ${error.message}`, quote(path), { cause: error })
    }
  }
  checkLinks(vfs, links)
  if (folded) checkCollisions(vfs)
  if (into === undefined) return { vfs, stats }
  mount(vfs, into, folded)
  return { vfs: into, stats }
}
