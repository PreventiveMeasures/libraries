// The settings a pnpm 10 install reads from the .npmrc beside the lockfile
// and from pnpm-workspace.yaml, the second over the first, as pnpm has it.
// Every key is one of three things: a setting read here, and held to the
// values this package builds a tree for; a setting that leaves the tree as
// it is, whether because a frozen lockfile already says what it would have
// changed, because it is about the network, the store, a cache, a script or
// a bin, or because it is a credential; or anything else, which is refused
// by name, as is a value read here that this package does not build for.
//
// Only these two files are read. Settings from anywhere else pnpm looks —
// a user or global .npmrc, `npm_config_*` in the environment, the root
// package.json's `pnpm` field, the command line — are not seen, and a tree
// built here is the one those leave at their defaults.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from './npmrc.js'

const REGISTRY = 'https://registry.npmjs.org/'

// An .npmrc value read only where it can mean one thing: not quoted, not
// escaped, with no `;` or `#` that ini would cut it at. Neither file's
// value is read where pnpm would fill it in from the environment.
const PLAIN = /^[^"'`;#\\]*$/u
function plain(value, where) {
  if (!PLAIN.test(value)) throw new DeptreeError(`${quote(value)} is quoted, escaped or commented, which is not read here`, where)
  return value
}

function noEnvironment(value, where) {
  if (typeof value === 'string' && value.includes('${')) throw new DeptreeError(`${quote(value)} is taken from the environment, which is not read here`, where)
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
  // A list: a string alone is a list of it, as pnpm reads one.
  texts(value, where) {
    const list = typeof value === 'string' ? [value] : value
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) throw new DeptreeError(`expected a string or a list of strings, found ${show(value)}`, where)
    return [...list]
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

const SCRIPTS = 'dependencies\' lifecycle scripts are never run here, so a tree they would build into cannot be built'
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
  ignorePatchFailures: only('boolean', false, 'a patch that does not apply is an error'),
  dangerouslyAllowAllBuilds: only('boolean', false, SCRIPTS),
  onlyBuiltDependencies: { kind: 'texts', check: (value, where) => { if (value.length > 0) throw new DeptreeError(SCRIPTS, where) } },
  allowBuilds: { kind: 'mapping', check: checkAllowBuilds },
  registry: { kind: 'text', check: checkRegistry },
  virtualStoreDirMaxLength: { kind: 'count' },
  hoist: { kind: 'boolean' },
  hoistPattern: { kind: 'texts' },
  publicHoistPattern: { kind: 'texts' },
  shamefullyHoist: { kind: 'boolean' },
  hoistWorkspacePackages: { kind: 'boolean' },
  engineStrict: { kind: 'boolean' },
  nodeVersion: { kind: 'text', check: checkNodeVersion },
  supportedArchitectures: { kind: 'mapping', check: checkArchitectures },
  patchedDependencies: { kind: 'mapping', check: checkPatches },
}

// Settings that leave the tree as it is. Resolution is done: the lockfile
// is what these made of the manifests. Fetching goes to the public
// registry alone, through @preventive/upstream, so the network and its
// credentials are its own; the store, caches and state live outside
// node_modules; scripts are never run and bins never written here.
const IGNORED = new Set([
  // resolution, already in the lockfile
  'allowNonAppliedPatches', 'allowUnusedPatches', 'allowedDeprecatedVersions', 'autoInstallPeers', 'blockExoticSubdeps',
  'catalog', 'catalogMode', 'catalogs', 'dedupeInjectedDeps', 'dedupePeerDependents', 'dedupePeers',
  'ignoredOptionalDependencies', 'linkWorkspacePackages', 'lockfileIncludeTarballUrl', 'minimumReleaseAge',
  'minimumReleaseAgeExclude', 'overrides', 'packageExtensions', 'packages', 'peerDependencyRules', 'peersSuffixMaxLength',
  'preferWorkspacePackages', 'registrySupportsTimeField', 'resolutionMode', 'resolvePeersFromWorkspaceRoot',
  'saveExact', 'savePrefix', 'saveWorkspaceProtocol', 'strictPeerDependencies',
  // the network, and credentials for it
  'alwaysAuth', 'ca', 'cafile', 'cert', 'email', 'fetchRetries', 'fetchRetryFactor', 'fetchRetryMaxtimeout',
  'fetchRetryMintimeout', 'fetchTimeout', 'httpProxy', 'httpsProxy', 'key', 'localAddress', 'maxsockets',
  'networkConcurrency', 'noProxy', 'noproxy', 'offline', 'preferOffline', 'proxy', 'strictSsl', 'userAgent',
  // the store, caches and state, none of it in node_modules
  'cacheDir', 'modulesCacheMaxAge', 'packageImportMethod', 'sideEffectsCache', 'sideEffectsCacheReadonly',
  'stateDir', 'storeDir', 'strictStorePkgContentCheck', 'verifyStoreIntegrity',
  // scripts, which are not run, and bins, which are not written
  'childConcurrency', 'enablePrePostScripts', 'extendNodePath', 'ignoreDepScripts', 'ignoreScripts',
  'ignoredBuiltDependencies', 'nodeOptions', 'preferSymlinkedExecutables', 'scriptShell', 'shellEmulator',
  'strictDepBuilds', 'unsafePerm', 'verifyDepsBeforeRun',
  // how the command runs
  'bail', 'ci', 'color', 'frozenLockfile', 'loglevel', 'managePackageManagerVersions',
  'packageManagerStrict', 'packageManagerStrictVersion', 'preferFrozenLockfile', 'recursiveInstall', 'reporter',
  'updateNotifier', 'useBetaCli', 'workspaceConcurrency',
])
// `_auth` and the like are credentials for the default registry.
const CREDENTIALS = new Set(['_auth', '_authToken', '_password', 'username'])

function checkRegistry(value, where) {
  if ((value.endsWith('/') ? value : `${value}/`) !== REGISTRY) throw new DeptreeError(`${quote(value)} is not supported: packages are fetched from ${REGISTRY} alone`, where)
}

function checkNodeVersion(value, where) {
  if (valid(value) === null) throw new DeptreeError(`${quote(value)} is not an exact version`, where)
}

function checkAllowBuilds(value, where) {
  for (const [name, build] of Object.entries(value)) {
    if (typeof build !== 'boolean') throw new DeptreeError(`expected true or false, found ${show(build)}`, `${where}.${name}`)
    if (build) throw new DeptreeError(SCRIPTS, `${where}.${name}`)
  }
}

const ARCHITECTURES = new Set(['os', 'cpu', 'libc'])
function checkArchitectures(value, where) {
  for (const [key, list] of Object.entries(value)) {
    if (!ARCHITECTURES.has(key)) throw new DeptreeError(`unsupported key ${quote(key)}`, where)
    readers.texts(list, `${where}.${key}`)
  }
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
// time; anything written for a scope or a registry URL is a credential or
// a registry of its own, which fetching from the public registry leaves
// alone unless it moves a scope off it.
function fromNpmrc(text) {
  const settings = new Map()
  for (const { key, value, list, line } of parseNpmrc(text)) {
    const where = `.npmrc:${line}: ${key}`
    // Where the variable is unset, pnpm drops the whole file, whatever the
    // setting: what it reads depends on an environment not read here.
    noEnvironment(key, where)
    noEnvironment(value, where)
    if (key.startsWith('//') || CREDENTIALS.has(key)) continue
    if (/^@[^:]+:registry$/u.test(key)) {
      checkRegistry(plain(value, where), where)
      continue
    }
    // pnpm reads a setting in an .npmrc by its kebab-case name alone, and
    // passes over any other spelling, which would read here as the setting.
    const name = KEBAB.test(key) ? camelCase(key) : undefined
    if (IGNORED.has(name)) continue
    if (!(name in READ)) throw new DeptreeError('unsupported setting', where)
    const earlier = settings.get(name)
    if (earlier !== undefined && !(list && earlier.list)) throw new DeptreeError('set more than once', where)
    if (list && READ[name].kind !== 'texts') throw new DeptreeError('not a list', where)
    const next = list ? [...(earlier?.value ?? []), plain(value, where)] : plain(value, where)
    settings.set(name, { value: next, list, where })
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
    if (IGNORED.has(name)) continue
    if (!(name in READ)) throw new DeptreeError('unsupported setting', where)
    settings.set(name, { value, where })
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
  }
}

// `workspace` is pnpm-workspace.yaml as parsed, `npmrc` the text of the
// .npmrc; either may be undefined. `os` is the host's, which one default
// depends on.
export function readSettings({ workspace, npmrc, os }) {
  const layers = [npmrc === undefined ? new Map() : fromNpmrc(npmrc), workspace === undefined ? new Map() : fromWorkspace(workspace)]
  const values = new Map()
  for (const layer of layers) {
    for (const [name, { value, where }] of layer) {
      const { kind, check } = READ[name]
      const read = readers[kind](value, where)
      check?.(read, where)
      values.set(name, read)
    }
  }
  return derive((name) => values.get(name), os)
}
