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
// Each package.json is read as pnpm reads it before that: through its
// read-package hook (hook.js), so a direct dependency overridden or an
// optional one ignored is held to the importer as overridden or left out;
// and held to the host by its engines (install.js's checkProject). The
// root one's packageManager, where it names one, has to be the pnpm the
// tree is built for: pnpm 10 would run that one instead.
//
// pnpm 11 lets an optional dependency the importer has no specifier for
// go unresolved, takes git specifiers of one commit to be the same however
// spelled, holds publishConfig.linkDirectory to the importer too, and
// makes frozen.js's further checks.
//
// Installs are frozen, always: pnpm 10's further checks without
// --frozen-lockfile, that workspace packages are linked exactly where
// their version is in range, are not made; pnpm 11 makes them frozen too.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, difference, quote } from '../error.js'
import { checkCatalogResolutions, checkLinkedPackages, refOf, sameSpecifier } from './frozen.js'
import { checkProject } from './install.js'
import { validForOldPackages } from './overrides.js'

const KINDS = ['optionalDependencies', 'dependencies', 'devDependencies']

// A package.json as parsed, as pnpm reads one: a byte order mark dropped,
// and an object.
function readManifest(text, where) {
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

const omit = (deps, names) => Object.fromEntries(Object.entries(deps).filter(([name]) => !names.has(name)))

// The dependencies pnpm reads a project as asking for: with
// autoInstallPeers, a peer it does not list elsewhere is a dependency; and
// those `unresolved` left out. The hook has held each of these fields to a
// mapping of strings.
function wantedOf(manifest, autoInstallPeers, unresolved) {
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, manifest[kind] ?? {}]))
  let all = omit({ ...kinds.devDependencies, ...kinds.dependencies, ...kinds.optionalDependencies }, unresolved)
  if (autoInstallPeers) {
    const peers = manifest.peerDependencies ?? {}
    const unlisted = Object.fromEntries(Object.entries(peers).filter(([name]) => !Object.hasOwn(all, name)))
    kinds.dependencies = { ...unlisted, ...kinds.dependencies }
    all = { ...peers, ...all }
  }
  return { kinds, all }
}

// dependenciesMeta as the lockfile reader hands it back: `injected` false
// where it is not set.
const metaOf = (meta) => JSON.stringify(Object.entries(meta).map(([name, item]) => [name, item?.injected === true, item?.node]).sort())

function checkKind(importer, kinds, kind, unresolved, major) {
  const locked = importer[kind]
  const wanted = kind === 'devDependencies' ? kinds[kind] : omit(kinds[kind], unresolved)
  const names = Object.keys(wanted).filter((name) => kind === 'optionalDependencies'
    || (!kinds.optionalDependencies[name] && (kind === 'dependencies' || !kinds.dependencies[name])))
  const unlinked = Object.values(locked).filter((target) => !target.includes('link:') && !target.includes('file:')).length
  if (names.length !== Object.keys(locked).length && names.length !== unlinked) return `${kind} in the lockfile do not match the same field in package.json`
  for (const name of names) {
    if (!locked[name] || !sameSpecifier(importer.specifiers[name], wanted[name], major)) return `${kind}.${name} is not what package.json asks for`
    const spec = importer.specifiers[name]
    if (validRange(spec) === null) continue
    const version = packageKeyOf(refOf(name, locked[name]))
    if (valid(version) !== null && !satisfies(version, spec)) return `${kind}.${name} resolved to ${quote(version)}, which is not in ${quote(spec)}`
  }
  return undefined
}

// Why pnpm would find `importer` not to be what `manifest` asks for, or
// undefined where it is; of the specifiers, the first difference, as
// pnpm's diffFlatRecords finds.
function mismatch(importer, manifest, autoInstallPeers, major, where) {
  const optional = manifest.optionalDependencies ?? {}
  const unresolved = new Set(major >= 11 ? Object.keys(optional).filter((name) => importer.specifiers[name] === undefined) : [])
  const { kinds, all } = wantedOf(manifest, autoInstallPeers, unresolved)
  const specified = difference(importer.specifiers, all, ['the lockfile', 'package.json'], (a, b) => sameSpecifier(a, b, major))
  if (specified !== undefined) return `the specifiers differ: ${specified}`
  const directory = manifest.publishConfig?.directory
  if (importer.publishDirectory !== directory) return `publishDirectory is ${quote(String(importer.publishDirectory))} in the lockfile and publishConfig.directory ${quote(String(directory))} in package.json`
  const linksDirectory = directory != null && manifest.publishConfig.linkDirectory !== false
  if (major >= 11 && (importer.publishDirectory !== undefined && importer.linkDirectory) !== linksDirectory) return `linkDirectory is ${!linksDirectory} in the lockfile and publishConfig.linkDirectory ${linksDirectory} in package.json`
  const meta = manifest.dependenciesMeta ?? {}
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new DeptreeError('expected a mapping', `${where}.dependenciesMeta`)
  if (metaOf(importer.dependenciesMeta) !== metaOf(meta)) return 'dependenciesMeta differs'
  for (const kind of KINDS) {
    const reason = checkKind(importer, kinds, kind, unresolved, major)
    if (reason !== undefined) return reason
  }
  return undefined
}

// devEngines.packageManager as pnpm 11 reads it: the pnpm one of a list,
// else its first, and what to do where it does not match.
function devEnginesPackageManager(devEngines, where) {
  const engines = devEngines?.packageManager
  if (!engines) return undefined
  const list = Array.isArray(engines) ? engines : [engines]
  if (list.some((item) => item === null || typeof item !== 'object')) throw new DeptreeError('expected a mapping or a list of mappings, which pnpm fails on otherwise', where)
  if (list.length === 0) return undefined
  const index = list.findIndex((item) => item.name === 'pnpm')
  const engine = list[Math.max(index, 0)]
  if (!engine.name) return undefined
  let { onFail } = engine
  if (Array.isArray(engines) && index === -1) onFail = list.at(-1).onFail ?? 'error'
  else if (Array.isArray(engines)) onFail ??= index === list.length - 1 ? 'error' : 'ignore'
  return { name: engine.name, onFail }
}

// packageManager as pnpm's parsePackageManager reads it, held to be this
// pnpm, exactly: pnpm switches to the version it names, and one it cannot
// switch to, or another package manager, is refused rather than run over.
// pnpm 11 reads devEngines.packageManager over it, and switches to the
// pnpm the lockfile pins for that, which is refused; either is passed
// over where what to do on a mismatch, or pmOnFail, is to warn or ignore.
function checkPackageManager(manifest, host, pmOnFail) {
  const { packageManager } = manifest
  if (host.major >= 11) {
    const where = 'manifests["."].devEngines.packageManager'
    const engine = devEnginesPackageManager(manifest.devEngines, where)
    const onFail = pmOnFail ?? engine?.onFail ?? 'download'
    if (onFail === 'ignore' || onFail === 'warn' || (engine === undefined && !packageManager)) return
    if (engine !== undefined) throw new DeptreeError('not supported: pnpm 11 installs with the pnpm the lockfile pins for it, where it does not refuse', where)
  }
  if (packageManager === undefined) return
  const where = 'manifests["."].packageManager'
  const version = typeof packageManager === 'string' ? /^pnpm@([^+:@]+)(?:\+.*)?$/u.exec(packageManager)?.[1] : undefined
  if (version === undefined || valid(version) !== version) throw new DeptreeError(`${quote(String(packageManager))} is not pnpm at an exact version`, where)
  if (version !== host.pnpm) throw new DeptreeError(`the project is installed by pnpm ${version}, which pnpm switches to, not ${host.pnpm}`, where)
}

// A runtime pnpm would download and install as a dependency, which is
// refused as the lockfile reader refuses a `runtime:` one. For the root
// project, pnpm 11 takes runtimeOnFail for each one's onFail, and checks a
// runtime whose onFail is `error` against the host's before it installs.
const RUNTIMES = [['devEngines', 'devDependencies'], ['engines', 'dependencies']]
function checkRuntimes(manifest, where, { host, onFail }) {
  const checked = new Set()
  for (const [field, kind] of RUNTIMES) {
    const runtime = manifest[field]?.runtime
    if (runtime === undefined || runtime === null) continue
    const here = `${where}.${field}.runtime`
    const runtimes = Array.isArray(runtime) ? runtime : [runtime]
    for (const name of ['node', 'deno', 'bun']) {
      if (manifest[kind]?.[name]) continue
      const item = runtimes.find((each) => each?.name === name)
      if (item !== undefined && (onFail ?? item.onFail) === 'download') throw new DeptreeError(`a ${name} runtime to download is not supported`, here)
    }
    if (host.major < 11 || where !== 'manifests["."]') continue
    if (runtimes.some((item) => item === null || typeof item !== 'object')) throw new DeptreeError('expected a mapping or a list of mappings, which pnpm 11 fails on otherwise', here)
    for (const item of runtimes) {
      if (!['node', 'deno', 'bun'].includes(item.name) || checked.has(item.name)) continue
      checked.add(item.name)
      if ((onFail ?? item.onFail) !== 'error') continue
      if (item.name !== 'node') throw new DeptreeError(`the ${item.name} it runs on is checked by pnpm 11, and is not known here`, here)
      if (!item.version || validRange(item.version) === null) throw new DeptreeError(`${quote(String(item.version))} is not a range for Node, which pnpm 11 refuses`, here)
      if (!satisfies(host.node, item.version, { includePrerelease: true })) throw new DeptreeError(`Node ${host.node} is not in ${quote(item.version)}, which pnpm 11 refuses to install with`, here)
    }
  }
}

// `hook` is hook.js's, which each package.json is read through; `host`
// and `settings` what its engines are held to.
export function checkProjects(lockfile, manifests, { hook, host, settings }) {
  checkPackageManager(manifests.get('.'), host, settings.pmOnFail)
  for (const [id, manifest] of manifests) {
    const where = `manifests[${quote(id)}]`
    checkProject(manifest, where, { host, settings })
    checkRuntimes(manifest, where, { host, onFail: id === '.' ? settings.runtimeOnFail : undefined })
    const hooked = hook(manifest, where, { local: 'refuse' })
    const importer = lockfile.importers[id]
    const reason = mismatch(importer, hooked, settings.autoInstallPeers, host.major, where)
    if (reason !== undefined) throw new DeptreeError(`the lockfile is not up to date with this package.json, which a frozen install refuses: ${reason}`, where)
    if (host.major < 11) continue
    checkCatalogResolutions(importer, lockfile.catalogs, where)
    checkLinkedPackages({ id, manifest: hooked, importer, projects: manifests, linkWorkspacePackages: settings.linkWorkspacePackages }, where)
  }
}

// The projects hoisting links by name where hoistWorkspacePackages is on:
// every one but the root that has a name, by its directory.
// Two of one name would leave which is hoisted to the order pnpm finds
// them in, and are refused.
export function workspaceNames(manifests) {
  const names = new Map()
  const taken = new Set()
  for (const [id, { name }] of manifests) {
    if (id === '.' || !name) continue
    const where = `manifests[${quote(id)}].name`
    if (typeof name !== 'string' || !validForOldPackages(name) || name.split('/').some((part) => part === '.' || part === '..')) {
      throw new DeptreeError(`${quote(String(name))} is not a name a package can be linked by`, where)
    }
    if (taken.has(name)) throw new DeptreeError(`${quote(name)} is the name of another project too`, where)
    taken.add(name)
    names.set(id, name)
  }
  return names
}
