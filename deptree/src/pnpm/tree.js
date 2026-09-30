// A node_modules tree as pnpm 10 or 11 installs it from a frozen lockfile
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

import { packageKeyOf, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { Vfs, VfsError } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { checkNoModules, mount } from '../mount.js'
import { applyPatch, parsePatch } from '../patch.js'
import { REGISTRY, checkDependencies, fetchPackage, sameBytes, tarballUrl } from '../tarball.js'
import { binTargets, checkPatchOfBins, fixBin } from './bins.js'
import { buildGraph } from './graph.js'
import { hoist } from './hoist.js'
import { checkLocalOverrides, readLinked } from './local.js'
import { createPatchedCheck, skippedSnapshots } from './install.js'
import { checkCollisions, checkLinks, checkOptional } from './checks.js'
import { createHook } from './hook.js'
import { listOverrides } from './overrides.js'
import { checkProjects, readManifests, workspaceNames } from './projects.js'
import { readSettings } from './settings.js'
import { checkUpToDate } from './uptodate.js'
import { checkWorkspace } from './workspace.js'

const CONCURRENCY = 8
const LIBC = new Set(['glibc', 'musl', 'unknown'])

function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with pnpm, node, os, cpu and libc')
  for (const key of ['pnpm', 'node', 'os', 'cpu', 'libc']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  const { pnpm, node, os, libc } = host
  const major = Number(valid(pnpm)?.split('.')[0])
  // What pnpm 11 does differently is read below, by `major`, where it is.
  if (major !== 10 && major !== 11) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: only pnpm 10 and 11 are`, 'host.pnpm')
  if (valid(node) === null) throw new DeptreeError(`${quote(node)} is not an exact version`, 'host.node')
  if (os === 'win32') throw new DeptreeError('Windows is not supported: pnpm links there with junctions to absolute paths', 'host.os')
  if (!LIBC.has(libc)) throw new DeptreeError(`expected "glibc", "musl" or "unknown", found ${quote(libc)}`, 'host.libc')
  return { pnpm, major, node, os, cpu: host.cpu, libc }
}

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
// tarball there with a sha512.
function checkRegistry(node) {
  const { key, pkg } = node
  const { resolution } = pkg
  const fromRegistry = pkg.version !== undefined && packageKeyOf(key) === `${pkg.name}@${pkg.version}` && resolution.type === 'tarball'
    && resolution.path === undefined && !resolution.gitHosted && (resolution.tarball ?? tarballUrl(pkg.name, pkg.version)) === tarballUrl(pkg.name, pkg.version)
  if (!fromRegistry) throw new DeptreeError(`only packages from ${REGISTRY} are supported`, quote(key))
  if (!resolution.integrity?.startsWith('sha512-')) throw new DeptreeError('expected a sha512 integrity', quote(key))
}

// What a package's snapshots all have of it, and it is fetched and held to.
const PACKAGE_FIELDS = ['resolution', 'os', 'cpu', 'libc', 'hasBin', 'bundledDependencies']
const packageFields = (pkg) => JSON.stringify(PACKAGE_FIELDS.map((field) => pkg[field]))

// Each package's files and package.json, by its name and version: a
// package is fetched once however many snapshots it has, a few at a time,
// and the first failure stops the rest from starting.
async function fetchAll(nodes) {
  const packages = new Map()
  for (const { key, pkg } of nodes.values()) {
    const id = packageKeyOf(key)
    if (!packages.has(id)) packages.set(id, pkg)
    else if (packageFields(packages.get(id)) !== packageFields(pkg)) throw new DeptreeError(`its snapshots differ on what the package is: ${PACKAGE_FIELDS.join(', ')}`, quote(id))
  }
  const queue = [...packages]
  const fetched = new Map()
  let failed = false
  const worker = async () => {
    while (queue.length > 0 && !failed) {
      const [id, pkg] = queue.shift()
      try {
        fetched.set(id, await fetchPackage(pkg, quote(id)))
      } catch (error) {
        failed = true
        throw error instanceof DeptreeError ? error : new DeptreeError(error.message, quote(id), { cause: error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  return fetched
}

// Each node with its package's files and package.json, by its directory:
// its dependencies held to the package.json, as `hook` reads it once for
// each package.
async function fetchNodes(nodes, hook) {
  const fetched = await fetchAll(nodes)
  const byDir = new Map()
  for (const node of nodes.values()) {
    const id = packageKeyOf(node.key)
    const got = fetched.get(id)
    got.read ??= hook(got.manifest, `${quote(id)}: package.json`)
    checkDependencies(got.manifest, got.read, node.pkg, quote(node.key))
    byDir.set(node.dir, { ...node, files: got.files, manifest: got.manifest })
  }
  return { byDir, tarballs: fetched.size }
}

// A snapshot's files as pnpm leaves them: its package's, the patch the
// snapshot names applied, and what linking bins does to them.
// `checkPatched` is createPatchedCheck's.
function compose(node, patches, targets, { major, checkPatched }) {
  const where = quote(node.key)
  let files = node.files
  const { patchHash } = node.pkg
  if (patchHash !== undefined) {
    if (!patches.has(patchHash)) throw new DeptreeError(`the patch ${patchHash} is not given`, where)
    const patch = patches.get(patchHash)
    patch.parsed ??= parsePatch(patch.text, patch.path)
    // Once for each package, whatever its snapshots.
    patch.applied ??= new WeakMap()
    if (!patch.applied.has(files)) patch.applied.set(files, applyPatch(files, patch.parsed))
    files = patch.applied.get(files)
    const manifest = checkPatchOfBins(node, files, targets, where, major)
    checkPatched?.(manifest, where)
  }
  if (targets.size === 0) return files
  files = new Map(files)
  for (const path of targets) files.set(path, fixBin(files.get(path), `${where}: ${quote(path)}`))
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

// Every link in the tree, by its path: each node's children beside it and
// itself inside it where it depends on itself, then what is hoisted, then
// each project's direct dependencies, which win over a hoisted alias.
// `byDir` is the graph by directory.
function linksOf(byDir, direct, settings, projects, major) {
  const links = new Map()
  for (const node of byDir.values()) {
    for (const [alias, dir] of node.children) if (alias !== node.name) links.set(`${node.modules}/${alias}`, dir)
    const self = node.children.get(node.name)
    if (byDir.has(self)) links.set(`${node.dir}/node_modules/${node.name}`, self)
  }
  for (const [path, dir] of hoist(byDir, direct, settings, projects, major)) links.set(path, dir)
  for (const [id, children] of direct) {
    for (const [alias, dir] of children) links.set(`${id === '.' ? '' : `${id}/`}node_modules/${alias}`, dir)
  }
  return links
}

// pnpm-workspace.yaml as parsed; one of comments alone, or nothing, sets
// nothing, as pnpm reads it.
const readWorkspace = (text) => (text === undefined || /^(?:[\t ]*(?:#.*)?(?:\r?\n|$))*$/u.test(text) ? undefined : parseYaml(text))

function readPatchesGiven(patches) {
  const entries = patches instanceof Map ? [...patches] : Object.entries(patches ?? {})
  for (const [path, text] of entries) {
    if (typeof text !== 'string') throw new TypeError(`patches[${quote(path)}] must be a string`)
  }
  return entries
}

export async function buildPnpmTree(options) {
  const { lockfile: text, manifests: manifestTexts, workspace, npmrc, patches, host: machine, vfs: into } = options ?? {}
  if (typeof text !== 'string') throw new TypeError('lockfile must be the text of pnpm-lock.yaml')
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  for (const [name, value] of [['workspace', workspace], ['npmrc', npmrc]]) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
  }
  const host = checkHost(machine)
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoModules(into, folded)
  const { lockfile, env } = parsePnpmLockfile(text)
  // pnpm 11 locks config dependencies there, which are refused, and the
  // pnpm a project pins, which leaves the tree as it is.
  if (env !== undefined && host.major < 11) throw new DeptreeError('the env document pnpm 11 writes is not supported', 'env')
  if (env !== undefined && Object.keys(env.importers['.'].configDependencies).length > 0) throw new DeptreeError('config dependencies are not supported', 'env.importers["."].configDependencies')
  if (!('.' in lockfile.importers)) throw new DeptreeError('expected the root project, whose package.json holds settings', 'importers')
  const manifests = readManifests(manifestTexts, lockfile)
  const settings = readSettings({ workspace: readWorkspace(workspace), npmrc, manifest: manifests.get('.'), major: host.major })
  checkLockfile(lockfile)
  checkWorkspace(Object.keys(lockfile.importers), settings.packages, host.major)
  const overrides = listOverrides(settings.overrides, settings.catalogs, host.major)
  checkLocalOverrides(overrides, into)
  const given = await checkUpToDate(lockfile, settings, overrides, readPatchesGiven(patches), host.major)
  const hook = createHook({ overrides, ignored: settings.ignoredOptionalDependencies, major: host.major })
  checkProjects(lockfile, manifests, { hook, host, settings })
  checkOptional(lockfile)
  const projects = settings.hoistWorkspacePackages ? workspaceNames(manifests) : new Map()
  const { skipped, incompatible } = skippedSnapshots(lockfile, { host, settings })
  const { nodes, direct } = await buildGraph(lockfile, skipped, settings.virtualStoreDirMaxLength, host.major)
  for (const node of nodes.values()) checkRegistry(node)

  const { byDir, tarballs } = await fetchNodes(nodes, hook)
  const links = linksOf(byDir, direct, settings, projects, host.major)
  const linked = readLinked(links, byDir, manifests, into)
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
      for (const [path, file] of compose(node, given, targets.get(node.dir) ?? new Set(), composing)) {
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
