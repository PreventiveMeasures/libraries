// The settings a pnpm 10 install reads from the .npmrc beside the lockfile,
// from pnpm-workspace.yaml, and from the root package.json's `pnpm` field,
// each over the one before: `pnpm install` spreads what the package.json
// sets over the config it read the others into, so there the package.json
// wins, whatever pnpm's config alone would say.
// In pnpm-workspace.yaml and the package.json, every key is one of three
// things: a setting read here, and held to the values this package builds
// a tree for; a setting that leaves the tree as it is, whether because a
// frozen lockfile already says what it would have changed, because it is
// about the network, the store, a cache, a script or a bin — no script is
// ever run, whatever a setting allows — or because it is a credential; or
// anything else, which is refused by name, as is a value read here that
// this package does not build for.
//
// An .npmrc is read as pnpm reads one: by the kebab-case names of its
// settings alone, and of those only the ones it has types for, which are
// npm's and its own. Every one of those that can change the tree is read
// here as above; anything else in the file — npm's settings pnpm has no
// use for, publishing's, credentials, any other spelling — pnpm passes
// over for an install, and so does this. A value pnpm would take from the
// environment is not known here: pnpm drops the whole file where one such
// variable is unset, so one in a line passed over is taken only where the
// file sets nothing that dropping it would change.
//
// Only these files are read. Settings from anywhere else pnpm looks — a
// user or global .npmrc, `npm_config_*` in the environment, the command
// line — are not seen, and a tree built here is the one those leave at
// their defaults. Of the package.json, pnpm 10 reads only the keys of
// `pnpm` below (MANIFEST_KEYS) and Yarn's `resolutions`, and so does this.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { REGISTRY } from '../tarball.js'
import { parseNpmrc } from './npmrc.js'
import { replaceReferences } from './overrides.js'

// An .npmrc value read only where it can mean one thing: not quoted, not
// escaped, with no `;` or `#` that ini would cut it at. Neither file's
// value is read where pnpm would fill it in from the environment.
const PLAIN = /^[^"'`;#\\]*$/u
function plain(value, where) {
  if (!PLAIN.test(value)) throw new DeptreeError(`${quote(value)} is quoted, escaped or commented, which is not read here`, where)
  return value
}

const fromEnvironment = (value) => typeof value === 'string' && value.includes('${')

function noEnvironment(value, where) {
  if (fromEnvironment(value)) throw new DeptreeError(`${quote(value)} is taken from the environment, which is not read here`, where)
  if (Array.isArray(value)) for (const item of value) noEnvironment(item, where)
  return value
}

const readers = {
  boolean(value, where) {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 'false') return value === 'true'
    throw new DeptreeError(`expected true or false, found ${show(value)}`, where)
  },
  count(value, where) {
    const number = typeof value === 'string' && /^\d{1,9}$/u.test(value) ? Number(value) : value
    if (Number.isSafeInteger(number) && number > 0) return number
    throw new DeptreeError(`expected a positive integer, found ${show(value)}`, where)
  },
  text(value, where) {
    if (typeof value === 'string') return value
    throw new DeptreeError(`expected a string, found ${show(value)}`, where)
  },
  // A list: a string alone is a list of it, as pnpm reads a hoist pattern.
  texts(value, where) {
    return readers.list(typeof value === 'string' ? [value] : value, where, 'a string or a list of strings')
  },
  // A list, and only a list: pnpm fails on a string alone where it sorts or
  // maps the value.
  list(value, where, expected = 'a list of strings') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new DeptreeError(`expected ${expected}, found ${show(value)}`, where)
    return [...value]
  },
  // pnpm-workspace.yaml's `packages`, which pnpm holds to a list of
  // non-empty strings.
  globs(value, where) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) throw new DeptreeError(`expected a list of non-empty strings, found ${show(value)}`, where)
    return [...value]
  },
  mapping(value, where) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    throw new DeptreeError(`expected a mapping, found ${show(value)}`, where)
  },
}

const show = (value) => (typeof value === 'string' ? quote(value) : Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value === 'object' ? 'a mapping' : String(value))

// Read, and held to one value: the default, or the only one built for.
const only = (kind, wanted, why) => ({ kind, check: (value, where) => {
  if (value !== wanted) throw new DeptreeError(`${show(value)} is not supported: ${why}`, where)
} })

// Read, and refused whatever it is.
const never = (why) => (value, where) => {
  throw new DeptreeError(`${show(value)} is not supported: ${why}`, where)
}

const READ = {
  __proto__: null,
  nodeLinker: only('text', 'isolated', 'only the isolated node_modules layout is built'),
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

// The keys of the root package.json's `pnpm` field pnpm 10 reads; it
// passes over any other there.
const MANIFEST_KEYS = [
  'allowBuilds', 'allowNonAppliedPatches', 'allowUnusedPatches', 'allowedDeprecatedVersions', 'auditConfig',
  'configDependencies', 'executionEnv', 'ignorePatchFailures', 'ignoredBuiltDependencies', 'ignoredOptionalDependencies',
  'neverBuiltDependencies', 'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'overrides', 'packageExtensions',
  'patchedDependencies', 'peerDependencyRules', 'requiredScripts', 'supportedArchitectures', 'updateConfig',
]

// Settings that leave the tree as it is. Resolution is done: the lockfile
// is what these made of the manifests, and a frozen install holds it to
// none of them (uptodate.js has those it does). Fetching goes to the public
// registry alone, through @preventive/upstream, so the network and its
// credentials are its own; the store, caches and state live outside
// node_modules; bins are never written here, and scripts never run, as
// with --ignore-scripts, whatever a setting would allow to build.
const IGNORED = new Set([
  // resolution, already in the lockfile
  'allowNonAppliedPatches', 'allowUnusedPatches', 'allowedDeprecatedVersions', 'blockExoticSubdeps', 'catalogMode',
  'dedupeInjectedDeps', 'dedupePeerDependents', 'linkWorkspacePackages', 'lockfileIncludeTarballUrl',
  'minimumReleaseAge', 'minimumReleaseAgeExclude', 'peerDependencyRules', 'preferWorkspacePackages',
  'registrySupportsTimeField', 'resolutionMode', 'resolvePeersFromWorkspaceRoot', 'saveExact', 'savePrefix',
  'saveWorkspaceProtocol', 'strictPeerDependencies',
  // the network, and credentials for it
  'alwaysAuth', 'ca', 'cafile', 'cert', 'email', 'fetchRetries', 'fetchRetryFactor', 'fetchRetryMaxtimeout',
  'fetchRetryMintimeout', 'fetchTimeout', 'httpProxy', 'httpsProxy', 'key', 'localAddress', 'maxsockets',
  'networkConcurrency', 'noProxy', 'noproxy', 'offline', 'preferOffline', 'proxy', 'strictSsl', 'userAgent',
  // the store, caches and state, none of it in node_modules
  'cacheDir', 'modulesCacheMaxAge', 'packageImportMethod', 'sideEffectsCache', 'sideEffectsCacheReadonly',
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

function checkRegistry(value, where) {
  if ((value.endsWith('/') ? value : `${value}/`) !== REGISTRY) throw new DeptreeError(`${quote(value)} is not supported: packages are fetched from ${REGISTRY} alone`, where)
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

// A catalog: by name, the specifier it gives the package.
function checkCatalog(value, where) {
  for (const [name, spec] of Object.entries(value)) readers.text(spec, `${where}.${name}`)
}

function checkCatalogs(value, where) {
  for (const [name, catalog] of Object.entries(value)) checkCatalog(readers.mapping(catalog, `${where}.${name}`), `${where}.${name}`)
}

// Whether a setting is read here; one that leaves the tree as it is is
// not, and one that is neither is refused.
function isRead(name, where) {
  if (IGNORED.has(name)) return false
  if (!(name in READ)) throw new DeptreeError('unsupported setting', where)
  return true
}

// By selector, the patch file, relative to the workspace's directory.
function checkPatches(value, where) {
  for (const [selector, path] of Object.entries(value)) {
    const here = `${where}[${quote(selector)}]`
    if (readers.text(path, here).startsWith('/')) throw new DeptreeError('an absolute patch path is not supported', here)
  }
}

const KEBAB = /^[a-z][\da-z]*(?:-[\da-z]+)*$/u
const camelCase = (key) => key.replace(/-+([a-z\d])/gu, (_, char) => char.toUpperCase())

// An .npmrc's settings by name, each written once, or once with `[]` each
// time, and whether any line takes something from the environment. A
// registry for a scope has to be the public one.
// pnpm 11 reads an .npmrc for credentials and registries alone, and passes
// over a registry of a project's .npmrc that names a variable.
function fromNpmrc(text, major) {
  const settings = new Map()
  let environment = false
  for (const { key, value, list, line } of parseNpmrc(text)) {
    const where = `.npmrc:${line}: ${key}`
    if (major >= 11) {
      if ((key === 'registry' || /^@[^:]+:registry$/u.test(key)) && !fromEnvironment(value)) checkRegistry(plain(value, where), where)
      continue
    }
    if (/^@[^:]+:registry$/u.test(key)) {
      checkRegistry(plain(noEnvironment(value, where), where), where)
      continue
    }
    const name = KEBAB.test(key) ? camelCase(key) : undefined
    if (!(name in READ) || READ[name].rc === false) {
      environment ||= fromEnvironment(key) || fromEnvironment(value)
      continue
    }
    noEnvironment(value, where)
    const earlier = settings.get(name)
    if (earlier !== undefined && !(list && earlier.list)) throw new DeptreeError('set more than once', where)
    if (list && READ[name].kind !== 'texts') throw new DeptreeError('not a list', where)
    const next = list ? [...(earlier?.value ?? []), plain(value, where)] : plain(value, where)
    settings.set(name, { value: next, list, where })
  }
  return { settings, environment }
}

// The root package.json's settings: the keys of `pnpm` pnpm reads, and
// overrides of `resolutions` and `pnpm.overrides` both, the second over the
// first.
function fromManifest(manifest) {
  const pnpm = manifest.pnpm === undefined ? {} : readers.mapping(manifest.pnpm, 'package.json: pnpm')
  const settings = new Map()
  for (const name of MANIFEST_KEYS) {
    if (!Object.hasOwn(pnpm, name) || name === 'overrides') continue
    const where = `package.json: pnpm.${name}`
    noEnvironment(pnpm[name], where)
    if (isRead(name, where)) settings.set(name, { value: pnpm[name], where })
  }
  const { resolutions } = manifest
  if (resolutions !== undefined || Object.hasOwn(pnpm, 'overrides')) {
    const where = 'package.json: resolutions and pnpm.overrides'
    const value = { ...(resolutions === undefined ? {} : readers.mapping(resolutions, 'package.json: resolutions')), ...(Object.hasOwn(pnpm, 'overrides') ? readers.mapping(pnpm.overrides, 'package.json: pnpm.overrides') : {}) }
    settings.set('overrides', { value, where })
  }
  return settings
}

function fromWorkspace(workspace) {
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) throw new DeptreeError('expected a mapping', 'pnpm-workspace.yaml')
  const settings = new Map()
  for (const [name, value] of Object.entries(workspace)) {
    const where = `pnpm-workspace.yaml: ${name}`
    noEnvironment(name, where)
    noEnvironment(value, where)
    if (isRead(name, where)) settings.set(name, { value, where })
  }
  return settings
}

// The settings as pnpm 10 derives what it installs by: `hoist: false`
// drops the private pattern, `shamefullyHoist` sets or drops the public
// one, and an empty public pattern is none. A pattern left undefined is
// not hoisted to at all.
function derive(get, os) {
  const shamefullyHoist = get('shamefullyHoist')
  let publicHoistPattern = get('publicHoistPattern') ?? []
  if (shamefullyHoist === true) publicHoistPattern = ['*']
  else if (shamefullyHoist === false || (publicHoistPattern.length === 1 && publicHoistPattern[0] === '')) publicHoistPattern = undefined
  return {
    virtualStoreDirMaxLength: get('virtualStoreDirMaxLength') ?? (os === 'win32' ? 60 : 120),
    hoistPattern: get('hoist') === false ? undefined : get('hoistPattern') ?? ['*'],
    publicHoistPattern,
    hoistWorkspacePackages: get('hoistWorkspacePackages') ?? true,
    engineStrict: get('engineStrict') ?? false,
    nodeVersion: get('nodeVersion'),
    supportedArchitectures: get('supportedArchitectures'),
    patchedDependencies: get('patchedDependencies'),
    overrides: get('overrides'),
    catalogs: catalogsOf(get('catalog'), get('catalogs')),
    packageExtensions: get('packageExtensions'),
    ignoredOptionalDependencies: get('ignoredOptionalDependencies') ?? [],
    autoInstallPeers: get('autoInstallPeers') ?? true,
    dedupePeers: get('dedupePeers') ?? false,
    peersSuffixMaxLength: get('peersSuffixMaxLength') ?? 1000,
    packages: get('packages'),
  }
}

// The catalogs by name, `catalog` being `default`, as pnpm has them, which
// refuses the default one written both ways.
function catalogsOf(catalog, catalogs = {}) {
  if (catalog !== undefined && Object.hasOwn(catalogs, 'default')) {
    throw new DeptreeError('the default catalog is defined twice, as catalog and as catalogs.default', 'pnpm-workspace.yaml: catalog')
  }
  return Object.assign(Object.create(null), catalog === undefined ? {} : { default: catalog }, catalogs)
}

// Each layer over the one before, as `derive` has them.
function settle(layers, manifest, os) {
  const values = new Map()
  for (const layer of layers) {
    for (const [name, { value, where }] of layer) {
      const { kind, check } = READ[name]
      let read = readers[kind](value, where)
      check?.(read, where)
      if (name === 'overrides') {
        if (Object.keys(read).length === 0) continue
        read = replaceReferences(read, manifest, where)
      }
      values.set(name, read)
    }
  }
  return derive((name) => values.get(name), os)
}

// `workspace` is pnpm-workspace.yaml as parsed and `npmrc` the text of the
// .npmrc, either of which may be undefined; `manifest` the root
// package.json as parsed. `os` is the host's, which one default depends
// on. Overrides that name nothing are none, and leave those below them.
export function readSettings({ workspace, npmrc, manifest, os, major = 10 }) {
  const rc = npmrc === undefined ? { settings: new Map(), environment: false } : fromNpmrc(npmrc, major)
  // pnpm 11 reads no setting from the package.json, its `resolutions` none.
  const rest = [workspace === undefined ? new Map() : fromWorkspace(workspace), major >= 11 ? new Map() : fromManifest(manifest)]
  const settings = settle([rc.settings, ...rest], manifest, os)
  if (rc.environment && JSON.stringify(settings) !== JSON.stringify(settle(rest, manifest, os))) {
    throw new DeptreeError('a line takes a value from the environment, which pnpm drops the whole file for where it is unset, and the file sets what would change the tree', '.npmrc')
  }
  return settings
}
