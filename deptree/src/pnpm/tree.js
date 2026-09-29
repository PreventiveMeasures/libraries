// A node_modules tree as pnpm 10 installs it from a frozen lockfile with
// the isolated linker, held in a Vfs rooted at the lockfile's directory:
// each package's files at node_modules/.pnpm/<its directory>/node_modules/
// <its name>, its dependencies linked beside it, the hoisted aliases in
// node_modules/.pnpm/node_modules and node_modules, and each project's
// direct dependencies in its own node_modules. Every link is relative, as
// pnpm makes them outside Windows, and a `link:` leads where the lockfile
// says whether or not anything is there: the tree holds node_modules and
// nothing else of the projects.
//
// Not written: bins and their shims (node_modules/.bin), which pnpm makes
// of each package's manifest, and the executable bit it gives the files
// they run; .modules.yaml, .pnpm/lock.yaml and the workspace state, which
// are pnpm's own; and anything a lifecycle script would build. The tree is
// always the one `pnpm install --ignore-scripts` makes: no script is run,
// a project's or a dependency's, whatever the settings allow, and patches
// are applied all the same, as pnpm applies them before any script.

import { packageKeyOf, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { Vfs } from '@preventive/vfs'
import { dirname, relative } from '@preventive/vfs/path.js'
import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { applyPatch, parsePatch } from '../patch.js'
import { fetchFiles, tarballUrl } from '../tarball.js'
import { buildGraph } from './graph.js'
import { hoist } from './hoist.js'
import { createCheck, skippedSnapshots } from './install.js'
import { checkCollisions, checkLinks, checkOptional } from './checks.js'
import { createHook } from './hook.js'
import { listOverrides } from './overrides.js'
import { checkProjects, readManifests, workspaceNames } from './projects.js'
import { readSettings } from './settings.js'
import { checkUpToDate } from './uptodate.js'

const CONCURRENCY = 8
const LIBC = new Set(['glibc', 'musl', 'unknown'])

function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with pnpm, node, os, cpu and libc')
  for (const key of ['pnpm', 'node', 'os', 'cpu', 'libc']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  const { pnpm, node, os, libc } = host
  if (valid(pnpm) === null || valid(pnpm).split('.')[0] !== '10') throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: only pnpm 10 is`, 'host.pnpm')
  if (valid(node) === null) throw new DeptreeError(`${quote(node)} is not an exact version`, 'host.node')
  if (os === 'win32') throw new DeptreeError('Windows is not supported: pnpm links there with junctions to absolute paths', 'host.os')
  if (!LIBC.has(libc)) throw new DeptreeError(`expected "glibc", "musl" or "unknown", found ${quote(libc)}`, 'host.libc')
  return { pnpm, node, os, cpu: host.cpu, libc }
}

// What the lockfile holds that no tree is built for here.
function checkLockfile(lockfile) {
  if (lockfile.settings.excludeLinksFromLockfile) throw new DeptreeError('links left out of the lockfile would be left out of the tree', 'settings.excludeLinksFromLockfile')
  if (lockfile.settings.injectWorkspacePackages) throw new DeptreeError('injected workspace packages are not supported', 'settings.injectWorkspacePackages')
  if (lockfile.pnpmfileChecksum !== undefined) throw new DeptreeError('a pnpmfile\'s hooks are not run here', 'pnpmfileChecksum')
  for (const [id, importer] of Object.entries(lockfile.importers)) {
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
  if (!fromRegistry) throw new DeptreeError('only packages from https://registry.npmjs.org/ are supported', quote(key))
  if (!resolution.integrity?.startsWith('sha512-')) throw new DeptreeError('expected a sha512 integrity', quote(key))
}

async function install(vfs, node, patches, hook) {
  const where = quote(node.key)
  try {
    const files = await fetchFiles(node.pkg, where, hook)
    vfs.mkdir(`/${node.dir}`, { recursive: true })
    for (const [path, { data, mode }] of files) {
      vfs.mkdir(dirname(`/${node.dir}/${path}`), { recursive: true })
      vfs.writeFile(`/${node.dir}/${path}`, data, { mode })
    }
    const { patchHash } = node.pkg
    if (patchHash === undefined) return
    if (!patches.has(patchHash)) throw new DeptreeError(`the patch ${patchHash} is not given`, where)
    const patch = patches.get(patchHash)
    patch.parsed ??= parsePatch(patch.text, patch.path)
    applyPatch(vfs, `/${node.dir}`, patch.parsed)
  } catch (error) {
    if (error instanceof DeptreeError) throw error
    throw new DeptreeError(error.message, where, { cause: error })
  }
}

// Each node's package, a few at a time; the first failure stops the rest
// from starting.
async function installAll(vfs, nodes, patches, hook) {
  const queue = [...nodes]
  let failed = false
  const worker = async () => {
    while (queue.length > 0 && !failed) {
      try {
        await install(vfs, queue.shift(), patches, hook)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
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
function linksOf(nodes, direct, settings, projects) {
  const byDir = new Map([...nodes.values()].map((node) => [node.dir, node]))
  const links = new Map()
  for (const node of nodes.values()) {
    for (const [alias, dir] of node.children) if (alias !== node.name) links.set(`${node.modules}/${alias}`, dir)
    const self = node.children.get(node.name)
    if (byDir.has(self)) links.set(`${node.dir}/node_modules/${node.name}`, self)
  }
  for (const [path, dir] of hoist(byDir, direct, settings, projects)) links.set(path, dir)
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
  const { lockfile: text, manifests: manifestTexts, workspace, npmrc, patches, host: machine } = options ?? {}
  if (typeof text !== 'string') throw new TypeError('lockfile must be the text of pnpm-lock.yaml')
  for (const [name, value] of [['workspace', workspace], ['npmrc', npmrc]]) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
  }
  const host = checkHost(machine)
  const { lockfile, env } = parsePnpmLockfile(text)
  if (env !== undefined) throw new DeptreeError('the env document pnpm 11 writes is not supported', 'env')
  if (!('.' in lockfile.importers)) throw new DeptreeError('expected the root project, whose package.json holds settings', 'importers')
  const manifests = readManifests(manifestTexts, lockfile)
  const settings = readSettings({ workspace: readWorkspace(workspace), npmrc, manifest: manifests.get('.'), os: host.os })
  checkLockfile(lockfile)
  const given = await checkUpToDate(lockfile, settings, readPatchesGiven(patches))
  const hook = createHook({ overrides: listOverrides(settings.overrides, settings.catalogs), ignored: settings.ignoredOptionalDependencies })
  checkProjects(lockfile, manifests, { hook, host, settings })
  checkOptional(lockfile)
  const projects = settings.hoistWorkspacePackages ? workspaceNames(manifests) : new Map()
  const skipped = skippedSnapshots(lockfile, createCheck({ host, settings }))
  const { nodes, direct } = await buildGraph(lockfile, skipped, settings.virtualStoreDirMaxLength)
  for (const node of nodes.values()) checkRegistry(node)
  const vfs = new Vfs()
  vfs.mkdir('/node_modules/.pnpm', { recursive: true })
  await installAll(vfs, nodes.values(), given, hook)
  const links = linksOf(nodes, direct, settings, projects)
  for (const [path, target] of links) {
    try {
      vfs.mkdir(dirname(`/${path}`), { recursive: true })
      vfs.symlink(linkTarget(path, target), `/${path}`)
    } catch (error) {
      throw new DeptreeError(`cannot be linked: ${error.message}`, quote(path), { cause: error })
    }
  }
  checkLinks(vfs, links)
  if (host.os === 'darwin') checkCollisions(vfs)
  return vfs
}
