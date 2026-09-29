// The projects a lockfile installs, each by its package.json, held to its
// importer as `pnpm install --frozen-lockfile` holds them
// (@pnpm/lockfile.verification's satisfiesPackageManifest): where one is
// not, pnpm refuses the lockfile as not up to date with that package.json,
// and resolves anew without --frozen-lockfile, so it is refused here too.
// Every project has to have an importer and every importer a project: the
// projects pnpm finds are what it installs, and an importer none of them
// is would be left out.
//
// A project's specifiers are its dependencies, devDependencies and
// optionalDependencies, and, with autoInstallPeers, the peerDependencies
// it does not also list otherwise, which pnpm installs as dependencies;
// each has to be what the importer records, under the kind pnpm files it
// under, and a version the importer resolved has to be in its range. Its
// publishConfig.directory and dependenciesMeta have to be the importer's.
//
// Without --frozen-lockfile pnpm holds workspace packages to more: that a
// dependency is linked exactly where the workspace's own version is in
// its range. A frozen install does not, and neither does this.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { validForOldPackages } from './overrides.js'

const KINDS = ['optionalDependencies', 'dependencies', 'devDependencies']

// A package.json as parsed, as pnpm reads one: a byte order mark dropped,
// and an object.
export function readManifest(text, where) {
  if (typeof text !== 'string') throw new TypeError(`${where} must be the text of a package.json`)
  let manifest
  try {
    manifest = JSON.parse(text.replace(/^﻿/u, ''))
  } catch (error) {
    throw new DeptreeError(`not JSON: ${error.message}`, where, { cause: error })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('expected an object', where)
  return manifest
}

// The manifests by project, the root one among them, as given by the
// project's directory relative to the lockfile's.
export function readManifests(manifests, lockfile) {
  if (manifests === null || typeof manifests !== 'object') throw new TypeError('manifests must map each project\'s directory to its package.json')
  const read = new Map()
  for (const [id, text] of manifests instanceof Map ? manifests : Object.entries(manifests)) {
    const where = `manifests[${quote(id)}]`
    if (!(id in lockfile.importers)) throw new DeptreeError('the lockfile has no importer for this project, which pnpm refuses a frozen install for', where)
    read.set(id, readManifest(text, where))
  }
  for (const id of Object.keys(lockfile.importers)) {
    if (!read.has(id)) throw new DeptreeError('the package.json of this project is not given', `importers[${quote(id)}]`)
  }
  return read
}

// The version an importer's target resolved to, as the lockfile spells
// it: a key of the alias's own name is its version and peers.
const refOf = (alias, target) => (target.startsWith(`${alias}@`) ? target.slice(alias.length + 1) : target)

const mapping = (value, where) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeptreeError('expected a mapping', where)
  return value
}

// The dependencies pnpm reads a project as asking for: with
// autoInstallPeers, a peer it does not list elsewhere is a dependency.
function wantedOf(manifest, autoInstallPeers, where) {
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, mapping(manifest[kind], `${where}.${kind}`)]))
  let all = { ...kinds.devDependencies, ...kinds.dependencies, ...kinds.optionalDependencies }
  if (autoInstallPeers) {
    const peers = mapping(manifest.peerDependencies, `${where}.peerDependencies`)
    const unlisted = Object.fromEntries(Object.entries(peers).filter(([name]) => !Object.hasOwn(all, name)))
    kinds.dependencies = { ...unlisted, ...kinds.dependencies }
    all = { ...peers, ...all }
  }
  return { kinds, all }
}

// The first way two flat mappings differ, as pnpm's diffFlatRecords finds.
function difference(locked, wanted) {
  for (const key of new Set([...Object.keys(locked), ...Object.keys(wanted)])) {
    if (!Object.hasOwn(wanted, key)) return `${quote(key)} is in the lockfile and not in package.json`
    if (!Object.hasOwn(locked, key)) return `${quote(key)} is in package.json and not in the lockfile`
    if (locked[key] !== wanted[key]) return `${quote(key)} is ${quote(locked[key])} in the lockfile and ${quote(String(wanted[key]))} in package.json`
  }
  return undefined
}

// dependenciesMeta as the lockfile reader hands it back: `injected` false
// where it is not set.
const metaOf = (meta) => JSON.stringify(Object.entries(meta).map(([name, item]) => [name, item?.injected === true, item?.node]).sort())

function checkKind(importer, kinds, kind) {
  const locked = importer[kind]
  const wanted = kinds[kind]
  const names = Object.keys(wanted).filter((name) => kind === 'optionalDependencies'
    || (!kinds.optionalDependencies[name] && (kind === 'dependencies' || !kinds.dependencies[name])))
  const unlinked = Object.values(locked).filter((target) => !target.includes('link:') && !target.includes('file:')).length
  if (names.length !== Object.keys(locked).length && names.length !== unlinked) return `${kind} in the lockfile do not match the same field in package.json`
  for (const name of names) {
    if (!locked[name] || importer.specifiers[name] !== wanted[name]) return `${kind}.${name} is not what package.json asks for`
    const spec = importer.specifiers[name]
    if (validRange(spec) === null) continue
    const version = packageKeyOf(refOf(name, locked[name]))
    if (valid(version) !== null && !satisfies(version, spec)) return `${kind}.${name} resolved to ${quote(version)}, which is not in ${quote(spec)}`
  }
  return undefined
}

// Why pnpm would find `importer` not to be what `manifest` asks for, or
// undefined where it is.
function mismatch(importer, manifest, autoInstallPeers, where) {
  const { kinds, all } = wantedOf(manifest, autoInstallPeers, where)
  const specified = difference(importer.specifiers, all)
  if (specified !== undefined) return `the specifiers differ: ${specified}`
  const directory = manifest.publishConfig?.directory
  if (importer.publishDirectory !== directory) return `publishDirectory is ${quote(String(importer.publishDirectory))} in the lockfile and publishConfig.directory ${quote(String(directory))} in package.json`
  const meta = mapping(manifest.dependenciesMeta, `${where}.dependenciesMeta`)
  if (metaOf(importer.dependenciesMeta) !== metaOf(meta)) return 'dependenciesMeta differs'
  for (const kind of KINDS) {
    const reason = checkKind(importer, kinds, kind)
    if (reason !== undefined) return reason
  }
  return undefined
}

export function checkProjects(lockfile, manifests, { autoInstallPeers }) {
  for (const [id, manifest] of manifests) {
    const where = `manifests[${quote(id)}]`
    const reason = mismatch(lockfile.importers[id], manifest, autoInstallPeers, where)
    if (reason !== undefined) throw new DeptreeError(`the lockfile is not up to date with this package.json, which pnpm refuses a frozen install for: ${reason}`, where)
  }
}

// The projects hoisting links by name where hoistWorkspacePackages is on:
// every one but the root that has a name, by its directory.
// Two of one name would leave which is hoisted to the order pnpm finds
// them in, and are refused.
export function workspaceNames(manifests) {
  const names = new Map()
  for (const [id, { name }] of manifests) {
    if (id === '.' || !name) continue
    const where = `manifests[${quote(id)}].name`
    if (typeof name !== 'string' || !validForOldPackages(name) || name.split('/').some((part) => part === '.' || part === '..')) {
      throw new DeptreeError(`${quote(String(name))} is not a name a package can be linked by`, where)
    }
    if ([...names.values()].includes(name)) throw new DeptreeError(`${quote(name)} is the name of another project too`, where)
    names.set(id, name)
  }
  return names
}
