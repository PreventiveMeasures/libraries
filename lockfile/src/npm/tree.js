// The tree npm loads a lockfile into, as Arborist's loadVirtual does: a node
// for each location, under the package whose node_modules it is in, or,
// for a directory a link leads to, under the nearest directory of the tree
// it is in, if any; a link at its location stands for what it leads to,
// such a directory or a package in another node_modules. A dependency is looked for as Node.js looks for one: in the
// node_modules of what asks for it, then of each node it is under.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative } from '../names.js'
import { entries, record } from '../shape.js'
import { compile, matches } from '../glob.js'
import { folderName, readEntry, readLink } from './entries.js'

const WHERE = 'packages'

const IN_NODE_MODULES = /^(?:(.+)\/)?node_modules\/((?:@[^/]+\/)?[^/]+)$/u

// A location from the lockfile's directory: the project's own, a directory
// a link leads to, or a folder of a node_modules, the package it is of.
function placeOf(location, where) {
  if (location === '') return { kind: 'root', parent: undefined, folder: undefined }
  checkRelative(location, where)
  const found = IN_NODE_MODULES.exec(location)
  if (found !== null) {
    if (found[2] === 'node_modules') throw new LockfileError('a folder named "node_modules", which no package is', where)
    return { kind: 'package', parent: found[1] ?? '', folder: checkName(found[2], where) }
  }
  const segments = location.split('/')
  if (segments.includes('node_modules')) throw new LockfileError('in a node_modules, but none of its packages', where)
  if (segments.every((segment) => segment === '..')) throw new LockfileError('a directory the project is in, which is not supported', where)
  return { kind: 'importer', parent: undefined, folder: folderName(location) }
}

function readNode(location, entry, where) {
  const { kind, parent, folder } = placeOf(location, where)
  const node = { location, where, kind, parentLocation: parent, folder, parent: undefined, fsParent: undefined, children: new Map(), links: [], edges: new Map(), edgesIn: [] }
  if (entry?.link === undefined) return Object.assign(node, readEntry(entry, where, kind === 'package' ? 'package' : 'importer', folder))
  if (kind !== 'package') throw new LockfileError('a link outside a node_modules, where npm writes none', where)
  return Object.assign(node, { kind: 'link', targetLocation: readLink(entry, where), target: undefined })
}

// A package, or a link, in the node_modules of its parent, which npm takes
// two names in other cases in as one.
function place(node, nodes) {
  const parent = nodes.get(node.parentLocation)
  if (parent === undefined) throw new LockfileError(`in the node_modules of ${quote(node.parentLocation)}, which the lockfile does not have`, node.where)
  if (parent.kind === 'link') throw new LockfileError(`in the node_modules of ${quote(node.parentLocation)}, a link, in which npm installs nothing`, node.where)
  const key = node.folder.toLowerCase()
  const other = parent.children.get(key)
  if (other !== undefined) throw new LockfileError(`in the folder of ${quote(other.location)} to npm, which takes names in one case`, node.where)
  parent.children.set(key, node)
  node.parent = parent
}

function link(node, nodes) {
  const target = nodes.get(node.targetLocation)
  const where = at(node.where, 'resolved')
  if (target === undefined) throw new LockfileError(`${quote(node.targetLocation)} is not in the lockfile, where npm looks for what a link leads to`, where)
  if (target.kind === 'root' || target.kind === 'link') {
    throw new LockfileError(`${quote(node.targetLocation)} is ${target.kind === 'root' ? 'the project' : 'a link'}, where npm links a directory or a package`, where)
  }
  node.target = target
  target.links.push(node)
}

// The nearest directory of the tree a directory is in; none out of the
// project's, which npm leaves to itself.
function fsParentOf(node, nodes) {
  const segments = node.location.split('/')
  while (segments.pop() !== undefined && segments.at(-1) !== '..') {
    const parent = nodes.get(segments.join('/'))
    if (parent !== undefined) return parent
  }
  return undefined
}

export const resolveParent = (node) => node.parent ?? node.fsParent

// What a node stands for: a package, or a directory; a link's, what it
// leads to.
export const packageOf = (node) => (node.kind === 'link' ? node.target : node)

// Node#resolve: the first of the name in a node_modules up the tree.
function resolve(node, name) {
  const key = name.toLowerCase()
  for (let from = node; from !== undefined; from = resolveParent(from)) {
    const child = from.children.get(key)
    if (child !== undefined) return child
  }
  return undefined
}

// Every node by location, the project's own, which npm writes only where it
// has something to say, among them.
export function readNodes(packages) {
  const nodes = new Map()
  for (const [location, entry, where] of entries(record(packages, WHERE), WHERE)) nodes.set(location, readNode(location, entry, where))
  if (!nodes.has('')) nodes.set('', readNode('', Object.create(null), at(WHERE, '')))
  for (const node of nodes.values()) {
    if (node.parentLocation !== undefined) place(node, nodes)
    if (node.kind === 'link') link(node, nodes)
  }
  for (const node of nodes.values()) {
    if (node.kind !== 'importer') continue
    if (node.links.length === 0) throw new LockfileError('a directory no link leads to, of which npm installs nothing', node.where)
    node.fsParent = fsParentOf(node, nodes)
  }
  return nodes
}

// @npmcli/map-workspaces, as npm maps the root's workspaces from the
// lockfile: each directory of the tree a glob matches, by its name.
export function readWorkspaces(nodes) {
  const root = nodes.get('')
  const where = at(root.where, 'workspaces')
  const found = new Map()
  const matched = new Set()
  for (const [index, glob] of (root.workspaces ?? []).entries()) {
    const tests = compile(glob.replace(/^\.?\/+/u, ''), `${where}[${index}]`)
    for (const node of nodes.values()) {
      if (node.kind !== 'importer' || matched.has(node) || !matches(tests, node.location)) continue
      const name = checkName(node.name, at(node.where, 'name'))
      if (found.has(name)) throw new LockfileError(`the name of the workspace ${quote(found.get(name).location)} too, of which npm keeps one`, node.where)
      found.set(name, node)
      matched.add(node)
    }
  }
  return found
}

const LISTS = { __proto__: null, workspace: 'workspaces', peer: 'peerDependencies', peerOptional: 'peerDependencies', prod: 'dependencies', optional: 'optionalDependencies', dev: 'devDependencies' }

// Where an edge is written in the lockfile.
export const edgeAt = (edge) => (edge.type === 'workspace' ? at(edge.from.where, 'workspaces') : at(at(edge.from.where, LISTS[edge.type]), edge.name))

// Node#loadDeps: a name's one edge is of the last list that has it, of the
// peer dependencies, the optional ones after, then dependencies, optional
// ones and, for a node on top of none, dev ones; a workspace's from the project, none but those.
// npm takes two names in other cases as one there too.
function loadEdges(node, workspaces, legacyPeerDeps) {
  const add = (name, type, spec) => {
    const key = name.toLowerCase()
    const prior = node.edges.get(key)
    if (prior?.type === 'workspace') return
    const edge = { name, type, spec, accept: node.acceptDependencies?.[name], from: node, to: undefined }
    if (prior !== undefined && prior.name !== name) throw new LockfileError(`${quote(prior.name)} too, to npm, which takes names in one case`, edgeAt(edge))
    node.edges.delete(key)
    node.edges.set(key, edge)
  }
  if (node.kind === 'root') for (const [name, { location }] of workspaces) add(name, 'workspace', `file:${location}`)
  const meta = node.peerDependenciesMeta ?? {}
  const peers = legacyPeerDeps ? [] : Object.entries(node.peerDependencies ?? {})
  for (const [name, spec] of peers) if (!meta[name]?.optional) add(name, 'peer', spec)
  for (const [name, spec] of peers) if (meta[name]?.optional) add(name, 'peerOptional', spec)
  for (const [name, spec] of Object.entries(node.dependencies ?? {})) add(name, 'prod', spec)
  for (const [name, spec] of Object.entries(node.optionalDependencies ?? {})) add(name, 'optional', spec)
  if (node.parent === undefined) for (const [name, spec] of Object.entries(node.devDependencies ?? {})) add(name, 'dev', spec)
}

// Each node's edges, and where each leads: a node, or nothing.
export function loadGraph(nodes, workspaces, legacyPeerDeps) {
  for (const node of nodes.values()) if (node.kind !== 'link') loadEdges(node, workspaces, legacyPeerDeps)
  for (const node of nodes.values()) {
    for (const edge of node.edges.values()) {
      edge.to = resolve(node, edge.name)
      edge.to?.edgesIn.push(edge)
    }
  }
}
