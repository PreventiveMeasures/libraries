// A package-lock.json of `lockfileVersion: 3`, as npm 9 to 12 write it
// by default: every field checked, the tree laid out as npm loads it, each
// dependency found where npm finds it, and held to what it asks for and to
// the flags npm writes of it. Any other version, any field not read here,
// and a package with a shrinkwrap of its own are refused.

import { LockfileError, quote } from '../error.js'
import { checkOptions, checkSemver, kind, record, refuse, text } from '../shape.js'
import { checkBundles } from './bundles.js'
import { checkFlags } from './flags.js'
import { readJson } from './json.js'
import { loadGraph, readNodes, readWorkspaces } from './tree.js'
import { checkEdges } from './valid.js'

const OPTIONS = ['checkVersions', 'semver', 'legacyPeerDeps']
const SEMVER = ['satisfies', 'valid', 'validRange']
const FIELDS = ['name', 'version', 'lockfileVersion', 'requires', 'packages']

function readOptions(options) {
  const { semver, legacyPeerDeps = false } = checkOptions(options, OPTIONS)
  const checkVersions = checkSemver(options, SEMVER)
  if (typeof legacyPeerDeps !== 'boolean') throw new TypeError('legacyPeerDeps: expected a boolean')
  return { semver: checkVersions ? semver : undefined, legacyPeerDeps }
}

// lockfileVersion 2 is the same with the tree again beside it, as npm 6
// reads one, and 1 that alone.
function readVersion(doc) {
  if (record(doc, undefined).lockfileVersion !== 3) throw new LockfileError(`unsupported version: expected 3, found ${kind(doc.lockfileVersion)}`, 'lockfileVersion')
  record(doc, undefined, FIELDS)
  if (doc.requires !== true) throw refuse('true', doc.requires, 'requires')
}

// The name and version npm writes above the packages are the project's: its
// directory's name where its package.json has none.
function readHeader(doc, root) {
  const name = text(doc.name, 'name')
  if (root.name !== undefined && root.name !== name) throw new LockfileError(`expected the project's, ${quote(root.name)}`, 'name')
  if (doc.version !== root.version) {
    throw new LockfileError(root.version === undefined ? 'a version, where the project has none' : `expected the project's, ${quote(root.version)}`, 'version')
  }
  return { name, version: root.version }
}

// A Target: a location in `packages`, or `link:` and the directory of an
// importer.
const targetOf = (node) => (node.kind === 'link' ? `link:${node.target.location}` : node.location)

function edgesOf(node) {
  const edges = Object.create(null)
  for (const edge of node.edges.values()) {
    edges[edge.name] = { type: edge.type, spec: edge.spec, accept: edge.accept, target: edge.to === undefined ? undefined : targetOf(edge.to) }
  }
  return edges
}

// What an importer and a package have alike, as npm reads it.
function manifestOf(node) {
  const { name, version, os, cpu, libc, license, funding, deprecated, hasInstallScript, flags } = node
  return {
    name,
    version,
    edges: edgesOf(node),
    bundleDependencies: node.bundleDependencies ?? [],
    engines: node.engines ?? Object.create(null),
    os,
    cpu,
    libc,
    bin: node.bin ?? Object.create(null),
    license,
    funding,
    deprecated,
    hasInstallScript,
    ...flags,
    devOptional: flags.devOptional || flags.dev || flags.optional,
  }
}

export function parseNpmLockfile(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { semver, legacyPeerDeps } = readOptions(options)
  const doc = readJson(source)
  readVersion(doc)
  const nodes = readNodes(doc.packages)
  const root = nodes.get('')
  const header = readHeader(doc, root)
  const workspaces = readWorkspaces(nodes)
  loadGraph(nodes, workspaces, legacyPeerDeps)
  checkEdges(nodes, semver)
  checkFlags(nodes)
  checkBundles(nodes)
  const workspaceOf = new Set(workspaces.values())
  const importers = Object.create(null)
  const packages = Object.create(null)
  const links = Object.create(null)
  // The project first, which the lockfile may leave out.
  for (const node of new Set([root, ...nodes.values()])) {
    if (node.kind === 'link') links[node.location] = node.target.location
    else if (node.kind === 'package') packages[node.location] = { ...manifestOf(node), resolution: node.resolution, inBundle: node.inBundle }
    else importers[node.location || '.'] = { ...manifestOf(node), workspace: workspaceOf.has(node), workspaces: node.workspaces ?? [] }
  }
  return { lockfileVersion: 3, ...header, importers, packages, links }
}
