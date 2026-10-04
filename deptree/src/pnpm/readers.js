// Each setting pnpm reads, by its pnpm-workspace.yaml name, is either read
// and checked (READ, READ_9, READ_11, READ_12) or passed over as leaving
// the tree as it is (IGNORED, NOT_9, IGNORED_11, IGNORED_12); any other is
// refused.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { REGISTRY } from '../tarball.js'

const ON_FAIL = new Set(['download', 'error', 'warn', 'ignore'])
const IMPORT_METHODS = new Set(['auto', 'hardlink', 'copy', 'clone', 'clone-or-copy'])

const show = (value) => (typeof value === 'string' ? quote(value) : Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value === 'object' ? 'a mapping' : String(value))

// `read` where `ok`, or else `value` refused as not `what`.
function checked(ok, value, what, where, read = value) {
  if (ok) return read
  throw new DeptreeError(`expected ${what}, found ${show(value)}`, where)
}

const oneOf = (allowed) => (value, where) => checked(allowed.has(value), value, `one of ${[...allowed].join(', ')}`, where)

export const readers = {
  boolean(value, where) {
    return value === 'true' || value === 'false' ? value === 'true' : checked(typeof value === 'boolean', value, 'true or false', where)
  },
  count(value, where) {
    const number = typeof value === 'string' && /^\d{1,9}$/u.test(value) ? Number(value) : value
    return checked(Number.isSafeInteger(number) && number > 0, value, 'a positive integer', where, number)
  },
  text: (value, where) => checked(typeof value === 'string', value, 'a string', where),
  // A string alone is a list of it, as pnpm reads a hoist pattern.
  texts(value, where) {
    return readers.list(typeof value === 'string' ? [value] : value, where, 'a string or a list of strings')
  },
  // Only a list: pnpm fails on a string alone where it sorts or maps it.
  list: (value, where, expected = 'a list of strings') => [...checked(Array.isArray(value) && value.every((item) => typeof item === 'string'), value, expected, where)],
  globs: (value, where) => [...checked(Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== ''), value, 'a list of non-empty strings', where)],
  mapping: (value, where) => checked(value !== null && typeof value === 'object' && !Array.isArray(value), value, 'a mapping', where),
  importMethod: oneOf(IMPORT_METHODS),
  onFail: oneOf(ON_FAIL),
  linkWorkspacePackages(value, where) {
    return value === 'deep' ? true : readers.boolean(value, where)
  },
  sideEffectsCache(value, where) {
    if (typeof value === 'boolean') return value
    if (readers.mapping(value, where).remote != null) never('what a build left in a remote cache is not restored here')(value.remote, `${where}.remote`)
    return value
  },
  // pnpm 11's per-project settings: by project name, or a list with `match`.
  packageConfigs(value, where) {
    const configs = Array.isArray(value) ? value.map((item, i) => [i, item]) : Object.entries(readers.mapping(value, where))
    for (const [key, config] of configs) {
      const here = `${where}[${quote(String(key))}]`
      for (const field of Object.keys(readers.mapping(config, here))) {
        if (field === 'saveExact' || field === 'savePrefix' || (field === 'match' && Array.isArray(value))) continue
        throw new DeptreeError(`${quote(field)} is not supported: of a project's settings, only saveExact and savePrefix are read`, here)
      }
    }
    return value
  },
}

const only = (kind, wanted, why) => ({ kind, check: (value, where) => value === wanted || never(why)(value, where) })

const never = (why) => (value, where) => {
  throw new DeptreeError(`${show(value)} is not supported: ${why}`, where)
}

export const READ = {
  __proto__: null,
  // pnpm 10's hoisted layout too (hoisted.js).
  nodeLinker: { kind: 'text', check: (value, where) => value === 'hoisted' || value === 'isolated' || never('only the isolated node_modules layout, and the hoisted one of pnpm 10, is built')(value, where) },
  symlink: only('boolean', true, 'a tree without its links is not built'),
  enableModulesDir: only('boolean', true, 'a tree without node_modules is not built'),
  modulesDir: only('text', 'node_modules', 'the modules directory is always node_modules'),
  virtualStoreDir: only('text', 'node_modules/.pnpm', 'the virtual store is always node_modules/.pnpm'),
  enableGlobalVirtualStore: only('boolean', false, 'a global virtual store is not built'),
  dedupeDirectDeps: only('boolean', false, 'direct dependencies are linked into every project'),
  injectWorkspacePackages: only('boolean', false, 'workspace packages are linked, never injected'),
  excludeLinksFromLockfile: only('boolean', false, 'links left out of the lockfile would be left out of the tree'),
  sharedWorkspaceLockfile: only('boolean', true, 'one lockfile is read for the whole workspace'),
  lockfile: only('boolean', true, 'the tree is the lockfile\'s'),
  packageLock: only('boolean', true, 'the tree is the lockfile\'s'),
  optional: only('boolean', true, 'optional dependencies are installed'),
  production: only('boolean', false, 'devDependencies are installed'),
  dev: only('boolean', false, 'dependencies are installed'),
  ignorePatchFailures: { ...only('boolean', false, 'a patch that does not apply is an error'), rc: false },
  force: only('boolean', false, 'optional packages the host cannot run are left out'),
  recursiveInstall: only('boolean', true, 'every project is installed'),
  ignoreWorkspace: only('boolean', false, 'the workspace is installed as one'),
  shamefullyFlatten: only('boolean', false, 'its old name is not read for shamefullyHoist'),
  gitBranchLockfile: only('boolean', false, 'the lockfile is the one given'),
  mergeGitBranchLockfiles: only('boolean', false, 'the lockfile is the one given'),
  mergeGitBranchLockfilesBranchPattern: { kind: 'texts', check: never('the lockfile is the one given') },
  lockfileDir: { kind: 'text', check: never('the lockfile is the one given, at the root of the tree') },
  lockfileDirectory: { kind: 'text', check: never('the lockfile is the one given, at the root of the tree') },
  only: { kind: 'text', check: never('dependencies and devDependencies are both installed') },
  filter: { kind: 'texts', check: never('every project is installed') },
  filterProd: { kind: 'texts', check: never('every project is installed') },
  useNodeVersion: { kind: 'text', check: never('the Node a tree is built for is the host\'s, or nodeVersion') },
  globalPnpmfile: { kind: 'text', check: never('a pnpmfile\'s hooks are not run here') },
  registry: { kind: 'text', check: checkRegistry },
  virtualStoreDirMaxLength: { kind: 'count' },
  hoist: { kind: 'boolean' },
  hoistPattern: { kind: 'texts' },
  publicHoistPattern: { kind: 'texts' },
  shamefullyHoist: { kind: 'boolean' },
  hoistWorkspacePackages: { kind: 'boolean' },
  engineStrict: { kind: 'boolean' },
  nodeVersion: { kind: 'text', check: checkNodeVersion },
  autoInstallPeers: { kind: 'boolean' },
  dedupePeers: { kind: 'boolean' },
  peersSuffixMaxLength: { kind: 'count' },
  // Whether a directory package's snapshots share hardlinked files (tree.js).
  packageImportMethod: { kind: 'importMethod' },
  // Neither pnpm's .npmrc nor ours has these.
  supportedArchitectures: { kind: 'mapping', check: checkArchitectures, rc: false },
  patchedDependencies: { kind: 'mapping', check: checkPatches, rc: false },
  overrides: { kind: 'mapping', rc: false },
  catalog: { kind: 'mapping', check: checkCatalog, rc: false },
  catalogs: { kind: 'mapping', check: checkCatalogs, rc: false },
  packageExtensions: { kind: 'mapping', rc: false },
  ignoredOptionalDependencies: { kind: 'list', rc: false },
  packages: { kind: 'globs', rc: false },
}

// What pnpm 11 reads that pnpm 10 has not, or reads otherwise.
const READ_11 = {
  __proto__: null,
  nodeLinker: { kind: 'text', check: (value, where) => value === 'hoisted' || value === 'isolated' || never('only the isolated node_modules layout, and the hoisted one of pnpm 10 and 11.28, is built')(value, where) },
  virtualStoreType: only('text', 'project', 'a global virtual store is not built'),
  virtualStoreOnly: only('boolean', false, 'a tree without its projects\' links is not built'),
  nodeExperimentalPackageMap: only('boolean', false, 'node_modules/.package-map.json is not written'),
  registries: { kind: 'mapping', check: checkRegistries },
  namedRegistries: { kind: 'mapping', check: (value, where) => Object.keys(value).length === 0 || never('packages are fetched from the public registry alone')(value, where) },
  remoteSideEffectsCache: { kind: 'mapping', check: never('what a build left in a remote cache is not restored here') },
  sideEffectsCache: { kind: 'sideEffectsCache' },
  packageConfigs: { kind: 'packageConfigs' },
  pmOnFail: { kind: 'onFail' },
  runtimeOnFail: { kind: 'onFail' },
  linkWorkspacePackages: { kind: 'linkWorkspacePackages' },
}

// The tree follows the lockfile, as pnpm 11's and 12's do with trustLockfile,
// so what pnpm 11 checks the lockfile against the registry by is passed over.
const IGNORED_11 = new Set([
  'minimumReleaseAgeIgnoreMissingTime', 'minimumReleaseAgeStrict', 'minimumReleaseAgeExcludePrune', 'trustLockfile',
  'trustPolicy', 'trustPolicyExclude', 'trustPolicyExcludePrune', 'trustPolicyIgnoreAfter', 'pnprServer',
  'fetchMinSpeedKiBps', 'fetchWarnTimeoutMs', 'fetchingConcurrency', 'gitShallowHosts', 'npmrcAuthFile', 'nodeDownloadMirrors',
  'frozenStore', 'globalVirtualStoreDir', 'dlxCacheMaxAge', 'optimisticRepeatInstall', 'forceIgnoresPlatform',
  'audit', 'auditLevel', 'update', 'tasks', 'versioning', 'patchesDir', 'syncInjectedDepsAfterScripts', 'nodePackageMapType',
  // a patch that does not apply is always an error in pnpm 11
  'ignorePatchFailures',
  // passed over in a project's pnpm-workspace.yaml
  'configDir', 'globalBinDir', 'globalDir', 'globalPkgDir', 'pnpmHomeDir', 'stateDir', 'userconfig', 'bin', 'dir',
  'rootProjectManifestDir', 'workspaceDir', 'authConfig', 'userConfig', 'configByUri', 'packageManagerNetworkConfig',
  'packageManagerRegistries', 'scope', 'hooks', 'finders', 'allProjects', 'selectedProjectsGraph', 'allProjectsGraph',
  'prodAllProjectsGraph', 'prodOnlySelectedProjectDirs', 'rootProjectManifest', 'enginePinManifest',
  'nodeVersionFromEnginesRuntime', 'cliOptions', 'explicitlySetKeys', 'packageManager', 'wantedPackageManager',
])

// What pnpm 12 adds that leaves an isolated tree as it is.
const IGNORED_12 = new Set([
  'autoDedupe', 'autoInstallPeersFromHighestMatch', 'externalDependencies', 'hoistingLimits', 'globalShims',
  'concurrencyGroups', 'pipelines', 'pipelineBase', 'publishWaitTimeout', 'saveTypes', 'tools', 'macosBackup',
])
const notEnabled = (value, where) => {
  if (value.enabled != null && value.enabled !== false) never('an install of Cargo or Python packages beside the tree is not supported')(value.enabled, `${where}.enabled`)
}
const READ_12 = {
  __proto__: null,
  nodeLinker: only('text', 'isolated', 'only the isolated node_modules layout is built for pnpm 12'),
  cargo: { kind: 'mapping', check: notEnabled },
  python: { kind: 'mapping', check: notEnabled },
}

const UNRECOGNIZED_12 = new Set([
  'allowNonAppliedPatches', 'alwaysAuth', 'email', 'enginePinManifest', 'ignoreDepScripts', 'ignorePatchFailures',
  'lockfileDirectory', 'managePackageManagerVersions', 'nodeVersionFromEnginesRuntime', 'packageManagerStrict',
  'packageManagerStrictVersion', 'shamefullyFlatten', 'useNodeVersion',
])

export const unrecognized12 = (where) => new DeptreeError('pnpm 12 does not know it, and fails on it where the root package.json pins the pnpm that runs', where)

// What pnpm 9 reads that pnpm 10 passes over: how it holds the root
// package.json's packageManager to the pnpm that runs (projects.js).
const READ_9 = {
  __proto__: null,
  nodeLinker: only('text', 'isolated', 'only the isolated node_modules layout is built for pnpm 9'),
  managePackageManagerVersions: { kind: 'boolean' },
  packageManagerStrict: { kind: 'boolean' },
  packageManagerStrictVersion: { kind: 'boolean' },
}

// What pnpm 10 reads that pnpm 9 has no setting for, and passes over.
const NOT_9 = new Set(['dedupePeers', 'enableGlobalVirtualStore', 'injectWorkspacePackages'])

// The keys of package.json's `pnpm` pnpm 9 reads, passing over any other.
export const MANIFEST_KEYS_9 = [
  'allowNonAppliedPatches', 'allowedDeprecatedVersions', 'ignoredOptionalDependencies', 'neverBuiltDependencies',
  'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'overrides', 'packageExtensions', 'patchedDependencies',
  'peerDependencyRules', 'supportedArchitectures',
]

// The keys of package.json's `pnpm` pnpm 10 reads, passing over any other.
export const MANIFEST_KEYS = [
  'allowBuilds', 'allowNonAppliedPatches', 'allowUnusedPatches', 'allowedDeprecatedVersions', 'auditConfig',
  'configDependencies', 'executionEnv', 'ignorePatchFailures', 'ignoredBuiltDependencies', 'ignoredOptionalDependencies',
  'neverBuiltDependencies', 'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'overrides', 'packageExtensions',
  'patchedDependencies', 'peerDependencyRules', 'requiredScripts', 'supportedArchitectures', 'updateConfig',
]

// A frozen install holds the lockfile to none of the resolution settings
// here (uptodate.js has those it does).
const IGNORED = new Set([
  // resolution, already in the lockfile
  'allowNonAppliedPatches', 'allowUnusedPatches', 'allowedDeprecatedVersions', 'blockExoticSubdeps', 'catalogMode',
  'dedupeInjectedDeps', 'dedupePeerDependents', 'linkWorkspacePackages', 'lockfileIncludeTarballUrl',
  'minimumReleaseAge', 'minimumReleaseAgeExclude', 'peerDependencyRules', 'preferWorkspacePackages',
  'registrySupportsTimeField', 'resolutionMode', 'resolvePeersFromWorkspaceRoot', 'saveExact', 'savePrefix',
  'saveWorkspaceProtocol', 'strictPeerDependencies',
  // the network and its credentials, which @preventive/upstream handles
  'alwaysAuth', 'ca', 'cafile', 'cert', 'email', 'fetchRetries', 'fetchRetryFactor', 'fetchRetryMaxtimeout',
  'fetchRetryMintimeout', 'fetchTimeout', 'httpProxy', 'httpsProxy', 'key', 'localAddress', 'maxsockets',
  'networkConcurrency', 'noProxy', 'noproxy', 'offline', 'preferOffline', 'proxy', 'strictSsl', 'userAgent',
  // the store, caches and state, none of it in node_modules
  'cacheDir', 'modulesCacheMaxAge', 'sideEffectsCache', 'sideEffectsCacheReadonly',
  'stateDir', 'storeDir', 'strictStorePkgContentCheck', 'verifyStoreIntegrity',
  // scripts, which are not run, and bins, which are not written
  'allowBuilds', 'childConcurrency', 'dangerouslyAllowAllBuilds', 'enablePrePostScripts', 'extendNodePath',
  'ignoreDepScripts', 'ignoreScripts', 'ignoredBuiltDependencies', 'neverBuiltDependencies', 'nodeOptions',
  'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'preferSymlinkedExecutables', 'scriptShell',
  'shellEmulator', 'strictDepBuilds', 'unsafePerm', 'verifyDepsBeforeRun',
  // how the command runs, and what other commands read
  'auditConfig', 'bail', 'ci', 'color', 'executionEnv', 'ignoreWorkspaceRootCheck', 'loglevel',
  'reporter', 'requiredScripts', 'updateConfig', 'updateNotifier', 'useBetaCli', 'workspaceConcurrency',
  // an install here is always frozen, whatever these say
  'frozenLockfile', 'preferFrozenLockfile',
  // the root package.json's packageManager is always held to be host.pnpm
  'managePackageManagerVersions', 'packageManagerStrict', 'packageManagerStrictVersion',
])

export function checkRegistry(value, where) {
  if ((value.endsWith('/') ? value : `${value}/`) !== REGISTRY) throw new DeptreeError(`${quote(value)} is not supported: packages are fetched from ${REGISTRY} alone`, where)
}

function checkRegistries(value, where) {
  for (const [scope, url] of Object.entries(value)) checkRegistry(readers.text(url, `${where}.${scope}`), `${where}.${scope}`)
}

function checkNodeVersion(value, where) {
  if (valid(value) === null) throw new DeptreeError(`${quote(value)} is not an exact version`, where)
}

const ARCHITECTURES = new Set(['os', 'cpu', 'libc'])
function checkArchitectures(value, where) {
  for (const [key, list] of Object.entries(value)) {
    if (!ARCHITECTURES.has(key)) throw new DeptreeError(`unsupported key ${quote(key)}`, where)
    readers.list(list, `${where}.${key}`)
  }
}

function checkCatalog(value, where) {
  for (const [name, spec] of Object.entries(value)) readers.text(spec, `${where}.${name}`)
}

function checkCatalogs(value, where) {
  for (const [name, catalog] of Object.entries(value)) checkCatalog(readers.mapping(catalog, `${where}.${name}`), `${where}.${name}`)
}

// `{}` where a setting leaves the tree as it is or pnpm 9 has no such setting,
// undefined where not known here. pnpm 12 takes a pattern only as a list.
function lookup(name, major) {
  if (major < 10 && name in READ_9) return { read: READ_9[name] }
  if (major < 10 && NOT_9.has(name)) return {}
  if (major >= 12 && UNRECOGNIZED_12.has(name)) return { unrecognized: true }
  if (major >= 12 && name in READ_12) return { read: READ_12[name] }
  if (major >= 11 && name in READ_11) return { read: READ_11[name] }
  if (IGNORED.has(name) || (major >= 11 && IGNORED_11.has(name)) || (major >= 12 && IGNORED_12.has(name))) return {}
  if (!(name in READ)) return undefined
  return { read: major >= 12 && READ[name].kind === 'texts' ? { ...READ[name], kind: 'list' } : READ[name] }
}

// An .npmrc setting pnpm passes over is undefined.
export function npmrcReader(name, major) {
  const read = lookup(name, major)?.read
  return read?.rc === false ? undefined : read
}

export function readerOf(name, where, major, pinned = false) {
  const found = lookup(name, major)
  if (found === undefined) throw new DeptreeError('unsupported setting', where)
  if (found.unrecognized && pinned) throw unrecognized12(where)
  return found.read
}

export function known12(name) {
  const found = lookup(name, 12)
  return found !== undefined && !found.unrecognized
}

function checkPatches(value, where) {
  for (const [selector, path] of Object.entries(value)) {
    const here = `${where}[${quote(selector)}]`
    if (readers.text(path, here).startsWith('/')) throw new DeptreeError('an absolute patch path is not supported', here)
  }
}
