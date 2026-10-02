// The project's package.json files, which npm ci reads from disk in place
// of the lockfile's entries, held to ask for exactly what those entries do.

import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { own } from '../manifest.js'
import { checkEngine, checkPlatform } from './compat.js'
import { checkDevEngines } from './dev-engines.js'

const where = (dir) => `manifests[${quote(dir)}]`

function specsOf(manifest, list, at) {
  const specs = manifest[list] ?? {}
  if (typeof specs !== 'object' || Array.isArray(specs) || Object.values(specs).some((spec) => typeof spec !== 'string')) {
    throw new DeptreeError('expected a mapping of names to specs, which npm fails without', `${at}.${list}`)
  }
  return specs
}

// Node#loadDeps: a name's edge is of the last list that has it, but a
// workspace's, which none takes over.
function edgesOf(manifest, at, workspaces, legacyPeerDeps) {
  const edges = new Map()
  const add = (name, type, spec) => {
    if (edges.get(name)?.type === 'workspace') return
    edges.delete(name)
    edges.set(name, { type, spec })
  }
  for (const [name, dir] of workspaces) add(name, 'workspace', `file:${dir}`)
  const peers = Object.entries(specsOf(manifest, 'peerDependencies', at))
  const meta = manifest.peerDependenciesMeta || {}
  if (!legacyPeerDeps) {
    for (const [name, spec] of peers) if (!own(meta, name)?.optional) add(name, 'peer', spec)
    for (const [name, spec] of peers) if (own(meta, name)?.optional) add(name, 'peerOptional', spec)
  }
  for (const [list, type] of [['dependencies', 'prod'], ['optionalDependencies', 'optional'], ['devDependencies', 'dev']]) {
    for (const [name, spec] of Object.entries(specsOf(manifest, list, at))) add(name, type, spec)
  }
  return edges
}

const describe = (edge) => (edge === undefined ? 'nothing' : `${edge.type} ${quote(edge.spec)}`)

function compareEdges(edges, importer, at) {
  for (const name of new Set([...edges.keys(), ...Object.keys(importer.edges)])) {
    const ours = edges.get(name)
    const theirs = importer.edges[name]
    if (ours?.type === theirs?.type && ours?.spec === theirs?.spec) continue
    throw new DeptreeError(`asks for ${quote(name)} as ${describe(ours)}, and the lockfile as ${describe(theirs)}, which npm ci refuses or resolves again`, at)
  }
}

// npm 10's #checkRootEdges: unless the root's edges are its lockfile lists
// to the letter (no name in two lists, no peer under legacy-peer-deps, no
// workspace asked for by name too), npm 10 works every flag out again.
export function recalculates(lists, edges) {
  const { dependencies = {}, devDependencies = {}, optionalDependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = lists
  const byType = { dev: devDependencies, optional: optionalDependencies, peer: { ...peerDependencies }, peerOptional: {}, prod: { ...dependencies } }
  for (const [name, meta] of Object.entries(peerDependenciesMeta)) {
    if (meta?.optional && own(byType.peer, name) !== undefined) {
      byType.peerOptional[name] = byType.peer[name]
      delete byType.peer[name]
    }
  }
  for (const name of Object.keys(optionalDependencies)) delete byType.prod[name]
  const left = new Set([...edges].filter(([, edge]) => edge.type !== 'workspace').map(([name]) => name))
  for (const [type, specs] of Object.entries(byType)) {
    for (const [name, spec] of Object.entries(specs)) {
      if (edges.get(name)?.type !== type || edges.get(name).spec !== spec) return true
      left.delete(name)
    }
  }
  return left.size > 0
}

// map-workspaces names a workspace by its package.json, or its folder.
function workspacesOf(manifests) {
  const workspaces = new Map()
  for (const [dir, manifest] of manifests) {
    if (dir === '.') continue
    const segments = dir.split('/')
    const name = manifest.name || (segments.at(-2)?.startsWith('@') ? segments.slice(-2).join('/') : segments.at(-1))
    if (workspaces.has(name)) throw new DeptreeError(`the name of the workspace ${quote(workspaces.get(name))} too, which npm fails on`, where(dir))
    workspaces.set(name, dir)
  }
  return workspaces
}

export const rootEdgesOf = (manifests, settings) => edgesOf(manifests.get('.'), where('.'), workspacesOf(manifests), settings.legacyPeerDeps)

// A workspace's name is held to the lockfile's by the root's edge to it.
// npm links its bins after every package's, so only one into its own
// node_modules changes the tree.
function checkWorkspace(dir, manifest, importer) {
  if (/[#%]/u.test(dir)) throw new DeptreeError('a workspace whose directory has a "#" or "%", which npm escapes in one place and not another, is not supported', where(dir))
  if (manifest.version !== importer.version) throw new DeptreeError(`is ${quote(String(manifest.version))}, and the lockfile has ${quote(String(importer.version))}, which npm ci refuses`, `${where(dir)}.version`)
  if (manifest.directories?.bin !== undefined) throw new DeptreeError('directories.bin, which npm reads otherwise across its releases, is not supported', `${where(dir)}.directories.bin`)
  const { bin } = manifest
  const targets = typeof bin === 'string' ? [bin] : bin !== null && typeof bin === 'object' ? Object.values(bin) : []
  if (targets.some((target) => typeof target === 'string' && /^node_modules(?:\/|$)/u.test(join('/', target.replace(/\\/gu, '/')).slice(1)))) {
    throw new DeptreeError('a bin in its own node_modules, which is another package\'s, is not supported', `${where(dir)}.bin`)
  }
}

// The root and workspaces are never left out; npm skips the root's engines
// where it has devEngines.
function checkHostOf(dir, manifest, host, settings) {
  const reason = checkPlatform(manifest, host, where(dir))
  if (reason !== undefined) throw new DeptreeError(`${reason}, which npm fails on`, where(dir))
  if (!settings.engineStrict || (dir === '.' && manifest.devEngines)) return
  const engine = checkEngine(manifest, host)
  if (engine !== undefined) throw new DeptreeError(`${engine}, which npm fails on with engine-strict`, where(dir))
}

export function checkManifests({ lockfile, manifests, settings, host, rootEdges }) {
  const root = manifests.get('.')
  if (root.overrides != null && (typeof root.overrides !== 'object' || Object.keys(root.overrides).length > 0)) {
    throw new DeptreeError('overrides, which change what npm asks for, are not supported', `${where('.')}.overrides`)
  }
  if (host.allowScripts && root.allowScripts !== undefined) throw new DeptreeError('allowScripts, which npm reads for whose bins to link, is not supported', `${where('.')}.allowScripts`)
  checkDevEngines(root.devEngines, host, `${where('.')}.devEngines`)
  for (const [dir, importer] of Object.entries(lockfile.importers)) {
    if (dir === '.') continue
    if (!importer.workspace) throw new DeptreeError('a directory linked by file:, not a workspace, is not supported', `importers[${quote(dir)}]`)
    if (!manifests.has(dir)) throw new DeptreeError('a workspace of the lockfile npm does not find', where(dir))
  }
  for (const [dir, manifest] of manifests) {
    const importer = lockfile.importers[dir]
    if (importer === undefined) throw new DeptreeError('a workspace the lockfile does not have, which npm ci refuses', where(dir))
    if (dir !== '.') checkWorkspace(dir, manifest, importer)
    if (manifest.acceptDependencies != null || Object.values(importer.edges).some((edge) => edge.accept !== undefined)) {
      throw new DeptreeError('acceptDependencies, which npm reads otherwise for devDependencies, is not supported', `${where(dir)}.acceptDependencies`)
    }
    compareEdges(dir === '.' ? rootEdges : edgesOf(manifest, where(dir), [], settings.legacyPeerDeps), importer, where(dir))
    if (host.reuse && dir !== '.' && manifest.scripts?.prepare) throw new DeptreeError('a workspace with a prepare script, which npm 10 runs even with --ignore-scripts, is not supported', `${where(dir)}.scripts.prepare`)
    checkHostOf(dir, manifest, host, settings)
  }
}
