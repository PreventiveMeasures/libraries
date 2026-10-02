// Each project's package.json, read through its read-package hook (hook.js),
// held to its importer as a frozen install holds it
// (@pnpm/lockfile.verification's satisfiesPackageManifest). Every importer
// has to be a project, or pnpm would leave it out. The check pnpm 10 makes
// only when not frozen, that workspace packages are linked exactly where
// their version is in range, is not made.

import { isExactVersion, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, difference, quote } from '../error.js'
import { own, readManifest } from '../manifest.js'
import { createMatcher } from '../matcher.js'
import { KINDS, checkCatalogResolutions, checkLinkTargets, checkLinkedPackages, indexProjects, resolvedOf, sameSpecifier } from './frozen.js'
import { checkProject } from './install.js'
import { validForOldPackages } from './overrides.js'
import { checkProjectId } from './workspace.js'

export function readManifests(manifests, lockfile) {
  if (manifests === null || typeof manifests !== 'object') throw new TypeError('manifests must map each project\'s directory to its package.json')
  const read = new Map()
  for (const [id, text] of manifests instanceof Map ? manifests : Object.entries(manifests)) {
    const where = `manifests[${quote(id)}]`
    if (!(id in lockfile.importers)) {
      checkProjectId(id, where)
      lockfile.importers[id] = { specifiers: {}, dependencies: {}, devDependencies: {}, optionalDependencies: {}, dependenciesMeta: {}, linkDirectory: true, made: true }
    }
    read.set(id, readManifest(text, where))
  }
  for (const id of Object.keys(lockfile.importers)) {
    if (!read.has(id)) throw new DeptreeError('the package.json of this project is not given', `importers[${quote(id)}]`)
  }
  return read
}

const omit = (deps, names) => Object.fromEntries(Object.entries(deps).filter(([name]) => !names.has(name)))

// The hook has held each of these fields to a mapping of strings.
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

// As the lockfile reader hands dependenciesMeta back: `injected` false where
// it is not set.
const metaOf = (meta) => JSON.stringify(Object.entries(meta).map(([name, item]) => [name, item?.injected === true, item?.node]).sort())

// pnpm 9 does not hold what a dependency resolved to to its range.
function checkKind(importer, kinds, kind, unresolved, major) {
  const locked = importer[kind]
  const wanted = kind === 'devDependencies' ? kinds[kind] : omit(kinds[kind], unresolved)
  const names = Object.keys(wanted).filter((name) => kind === 'optionalDependencies'
    || (!own(kinds.optionalDependencies, name) && (kind === 'dependencies' || !own(kinds.dependencies, name))))
  const unlinked = Object.values(locked).filter((target) => !target.includes('link:') && !target.includes('file:')).length
  if (names.length !== Object.keys(locked).length && names.length !== unlinked) return `${kind} in the lockfile do not match the same field in package.json`
  for (const name of names) {
    if (!locked[name] || !sameSpecifier(importer.specifiers[name], wanted[name], major)) return `${kind}.${name} is not what package.json asks for`
    const spec = importer.specifiers[name]
    if (major < 10 || validRange(spec) === null) continue
    const version = resolvedOf(name, locked[name])
    if (valid(version) !== null && !satisfies(version, spec)) return `${kind}.${name} resolved to ${quote(version)}, which is not in ${quote(spec)}`
  }
  return undefined
}

// Why pnpm finds `importer` out of date: of the specifiers, the first
// difference, as pnpm's diffFlatRecords finds.
function mismatch(importer, manifest, autoInstallPeers, major, where) {
  const unresolved = new Set(major >= 11 ? Object.keys(manifest.optionalDependencies ?? {}).filter((name) => importer.specifiers[name] === undefined) : [])
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

// devEngines.packageManager as pnpm 11 reads it.
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

// The exact pnpm version packageManager names, per pnpm's parsePackageManager.
export function pinnedPnpm(packageManager) {
  const version = typeof packageManager === 'string' ? /^pnpm@([^+:@]+)(?:\+.*)?$/u.exec(packageManager)?.[1] : undefined
  return isExactVersion(version) ? version : undefined
}

// The root's pin, as pnpm 12's wanted_package_manager reads it.
function wantedPackageManager(manifest) {
  const declared = manifest.devEngines?.packageManager
  const list = Array.isArray(declared) ? declared : declared == null ? [] : [declared]
  const index = Array.isArray(declared) ? Math.max(list.findIndex((entry) => entry?.name === 'pnpm'), 0) : 0
  const entry = list[index]
  if (typeof entry?.name === 'string') {
    const onFail = typeof entry.onFail === 'string' ? entry.onFail : Array.isArray(declared) ? (index === list.length - 1 ? 'error' : 'ignore') : undefined
    const version = typeof entry.version === 'string' && validRange(entry.version) !== null ? entry.version : undefined
    return { name: entry.name, version, devEngines: true, onFail }
  }
  if (typeof manifest.packageManager !== 'string') return undefined
  const [, name, version] = /^(@?[^@]*)(?:@(.*))?$/u.exec(manifest.packageManager)
  const exact = version === undefined ? undefined : version.replace(/\+.*$/u, '')
  return { name, version: isExactVersion(exact) && valid(exact) === exact ? exact : undefined, devEngines: false, onFail: undefined }
}

// Whether the root package.json pins a pnpm that `pnpm` is, which makes
// pnpm 12 fail on a setting it does not know.
export function pinsPnpm(manifest, pnpm) {
  const wanted = wantedPackageManager(manifest)
  return wanted?.name === 'pnpm' && wanted.version !== undefined && satisfies(pnpm, wanted.version, { includePrerelease: true })
}

// pnpm 12 runs the pnpm the lockfile's env document records for a pin. It
// records one for a devEngines pin, or a packageManager one of 12 or later,
// at the pinned version or, for a range, the running one.
function checkPackageManager12(manifest, host, pmOnFail, env) {
  const wanted = wantedPackageManager(manifest)
  if (wanted === undefined) return
  const where = `manifests["."].${wanted.devEngines ? 'devEngines.packageManager' : 'packageManager'}`
  const onFail = pmOnFail ?? wanted.onFail ?? 'download'
  if (onFail === 'ignore' || (onFail === 'warn' && wanted.name !== 'pnpm')) return
  if (wanted.name !== 'pnpm') throw new DeptreeError(`the project is installed by ${quote(wanted.name)}, which pnpm 12 refuses`, where)
  if (wanted.version === undefined) throw new DeptreeError('it names no version of pnpm, or none pnpm takes, which is not supported', where)
  const running = satisfies(host.pnpm, wanted.version, { includePrerelease: true })
  if (!running && onFail !== 'warn') throw new DeptreeError(`pnpm ${host.pnpm} is not in ${quote(wanted.version)}, which pnpm 12 switches from or refuses`, where)
  if (!wanted.devEngines && Number(wanted.version.split('.')[0]) < 12) return
  const version = isExactVersion(wanted.version) ? wanted.version : running ? host.pnpm : undefined
  if (version === undefined) return
  const recorded = env?.importers['.'].packageManagerDependencies ?? {}
  const here = 'env.importers["."].packageManagerDependencies'
  if (recorded.pnpm === undefined) throw new DeptreeError(`the lockfile records no pnpm for ${where}, which a frozen install of pnpm 12 fails on`, here)
  for (const [name, key] of Object.entries(recorded)) {
    if (key !== `${name}@${version}`) throw new DeptreeError(`${quote(key)} is not ${name} ${version}, which pnpm 12 would run or fail on`, `${here}.${name}`)
    if (env.packages[key] === undefined) throw new DeptreeError(`the lockfile records no package ${quote(key)}, which a frozen install of pnpm 12 fails on`, `${here}.${name}`)
  }
}

// pnpm 9's parsePackageManager.
function parsePackageManager(packageManager) {
  if (!packageManager.includes('@')) return { name: packageManager, version: undefined }
  const [name, reference] = packageManager.split('@')
  return { name, version: reference.includes(':') ? undefined : reference.split('+')[0] }
}

// pnpm 9 switches to the pnpm packageManager pins only with
// managePackageManagerVersions; otherwise it refuses another package
// manager with packageManagerStrict, and another pnpm with that and
// packageManagerStrictVersion, and installs with itself. 9.15.0 switches
// to a version semver reads but spells otherwise, and later 9.15s do not.
function checkPackageManager9(manifest, host, { manage, strict, strictVersion }) {
  const { packageManager } = manifest
  if (!packageManager) return
  const where = 'manifests["."].packageManager'
  if (typeof packageManager !== 'string') throw new DeptreeError('expected a string, which pnpm 9 fails on otherwise', where)
  const { name, version } = parsePackageManager(packageManager)
  if (manage && name === 'pnpm') {
    const exact = version === undefined ? null : valid(version)
    if (version === undefined || version === host.pnpm || exact === null) return
    if (exact !== version.trim()) throw new DeptreeError(`pnpm ${quote(version)} is one pnpm 9.15.0 switches to and a later 9.15 does not, which is not supported`, where)
    throw new DeptreeError(`the project is installed by pnpm ${version}, which pnpm 9 switches to with managePackageManagerVersions, not ${host.pnpm}`, where)
  }
  if (name && name !== 'pnpm' && strict) throw new DeptreeError(`the project is installed by ${quote(name)}, which pnpm 9 refuses with packageManagerStrict`, where)
  if (name === 'pnpm' && strict && strictVersion && version && version !== host.pnpm) throw new DeptreeError(`the project is installed by pnpm ${version}, not ${host.pnpm}, which pnpm 9 refuses with packageManagerStrict and packageManagerStrictVersion`, where)
}

function checkPackageManager(manifest, host, settings, env) {
  const { pmOnFail } = settings
  if (host.major < 10) return checkPackageManager9(manifest, host, settings.packageManagerChecks)
  if (host.major >= 12) return checkPackageManager12(manifest, host, pmOnFail, env)
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
  const version = pinnedPnpm(packageManager)
  if (version === undefined) throw new DeptreeError(`${quote(String(packageManager))} is not pnpm at an exact version`, where)
  if (version !== host.pnpm) throw new DeptreeError(`the project is installed by pnpm ${version}, which pnpm switches to, not ${host.pnpm}`, where)
}

// A runtime pnpm would download as a dependency is refused, as the lockfile
// reader refuses a `runtime:` one.
const RUNTIMES = [['devEngines', 'devDependencies'], ['engines', 'dependencies']]
const RUNTIME_NAMES = ['node', 'deno', 'bun']
function checkRuntimes(manifest, where, { host, root, onFail }) {
  // pnpm 9 knows no runtime.
  if (host.major < 10) return
  const checked = new Set()
  for (const [field, kind] of RUNTIMES) {
    const runtime = manifest[field]?.runtime
    if (runtime == null) continue
    const here = `${where}.${field}.runtime`
    const runtimes = Array.isArray(runtime) ? runtime : [runtime]
    for (const name of RUNTIME_NAMES) {
      if (manifest[kind]?.[name]) continue
      const item = runtimes.find((each) => each?.name === name)
      if (item !== undefined && (onFail ?? item.onFail) === 'download') throw new DeptreeError(`a ${name} runtime to download is not supported`, here)
    }
    if (host.major < 11 || !root) continue
    if (runtimes.some((item) => item === null || typeof item !== 'object')) throw new DeptreeError('expected a mapping or a list of mappings, which pnpm 11 fails on otherwise', here)
    for (const item of runtimes) {
      if (!RUNTIME_NAMES.includes(item.name) || checked.has(item.name)) continue
      checked.add(item.name)
      if ((onFail ?? item.onFail) !== 'error') continue
      if (item.name !== 'node') throw new DeptreeError(`the ${item.name} it runs on is checked by pnpm 11, and is not known here`, here)
      if (!item.version || validRange(item.version) === null) throw new DeptreeError(`${quote(String(item.version))} is not a range for Node, which pnpm 11 refuses`, here)
      if (!satisfies(host.node, item.version, { includePrerelease: true })) throw new DeptreeError(`Node ${host.node} is not in ${quote(item.version)}, which pnpm 11 refuses to install with`, here)
    }
  }
}

// pnpm 12 counts no ignored optional dependency, nor any peer.
function dependsOn(manifest, ignored) {
  const names = (deps) => (deps !== null && typeof deps === 'object' ? Object.keys(deps) : [])
  const optional = new Set(names(manifest.optionalDependencies).filter((name) => ignored(name)))
  return names(manifest.devDependencies).length > 0 || [...names(manifest.dependencies), ...names(manifest.optionalDependencies)].some((name) => !optional.has(name))
}

export function checkProjects(lockfile, manifests, { hook, host, settings, env }) {
  checkPackageManager(manifests.get('.'), host, settings, env)
  const ignored = createMatcher(settings.ignoredOptionalDependencies ?? [])
  let index
  for (const [id, manifest] of manifests) {
    const where = `manifests[${quote(id)}]`
    const root = id === '.'
    checkProject(manifest, where, { host, settings, root })
    checkRuntimes(manifest, where, { host, root, onFail: root ? settings.runtimeOnFail : undefined })
    const importer = lockfile.importers[id]
    if (host.major >= 12 && importer.made) {
      if (dependsOn(manifest, ignored)) throw new DeptreeError('the lockfile has no importer for this project, which has dependencies, and pnpm 12 refuses it', where)
      continue
    }
    const hooked = hook(manifest, where, { dir: id })
    const reason = mismatch(importer, hooked, settings.autoInstallPeers, host.major, where)
    if (reason !== undefined) throw new DeptreeError(`the lockfile is not up to date with this package.json, which a frozen install refuses: ${reason}`, where)
    checkLinkTargets({ id, manifest: hooked, importer }, where)
    if (host.major !== 11) continue
    checkCatalogResolutions(importer, lockfile.catalogs, where)
    index ??= indexProjects(manifests)
    checkLinkedPackages({ manifest: hooked, importer, index, linkWorkspacePackages: settings.linkWorkspacePackages }, where)
  }
}

// The names hoistWorkspacePackages links projects by. Two of one name are
// refused, as which is hoisted would turn on the order pnpm finds them in.
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
