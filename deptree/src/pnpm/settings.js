// The settings a pnpm 10 install reads from the .npmrc beside the
// lockfile, pnpm-workspace.yaml and the root package.json's `pnpm` field,
// each over the one before: `pnpm install` spreads the package.json's over
// the rest, whatever pnpm's config alone would say. Every key of the yaml
// and the package.json is read here and held to what this package builds
// for, or known to leave the tree as it is (a frozen lockfile already
// settles it; it is about the network, the store, a cache, a script or a
// bin, as no script is ever run; or it is a credential), or refused by
// name (readers.js).
//
// An .npmrc is read as pnpm reads one, by the kebab-case names it has
// types for, npm's and its own: those that can change the tree are read
// here, and the rest passed over, as pnpm does for an install. pnpm drops
// the whole file where a variable it names is unset, so one is taken only
// in a line passed over, and only where dropping the file would change
// nothing. Settings from anywhere else (a user or global .npmrc,
// `npm_config_*`, the command line) are taken to be at their defaults.
//
// pnpm 11 reads settings from pnpm-workspace.yaml alone: an .npmrc only
// for credentials and registries, the package.json only for
// runtimeNodeVersion. It passes over a yaml key not in camelCase, or about
// the machine, the run or a login, and reads linkWorkspacePackages for a
// frozen install too. pnpm 12 reads them as pnpm 11 does, but where the
// root package.json pins the pnpm that runs, it fails on a yaml key with
// a value it does not know, and drops it otherwise. readers.js has what
// each adds (READ_11, IGNORED_11, READ_12, IGNORED_12, UNRECOGNIZED_12).

import { valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from '../npmrc.js'
import { replaceReferences } from './overrides.js'
import { IGNORED, MANIFEST_KEYS, READ, checkRegistry, known12, readerOf, readers, unrecognized12 } from './readers.js'

// An .npmrc value is read only where it can mean one thing: not quoted,
// not escaped, with no `;` or `#` that ini would cut it at.
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

const KEBAB = /^[a-z][\da-z]*(?:-[\da-z]+)*$/u
const camelCase = (key) => key.replace(/-+([a-z\d])/gu, (_, char) => char.toUpperCase())

// pnpm 11 reads an .npmrc for credentials and registries alone: each
// registry has to be the public one, but one of a project's .npmrc that
// names a variable is passed over.
function checkNpmrcRegistries(text) {
  for (const { key, value, line } of parseNpmrc(text)) {
    if ((key !== 'registry' && !/^@[^:]+:registry$/u.test(key)) || fromEnvironment(value)) continue
    const where = `.npmrc:${line}: ${key}`
    checkRegistry(plain(value, where), where)
  }
}

// Each setting has to be written once, or with `[]` every time;
// `environment` is whether a line passed over names a variable.
function fromNpmrc(text) {
  const settings = new Map()
  let environment = false
  for (const { key, value, list, line } of parseNpmrc(text)) {
    const where = `.npmrc:${line}: ${key}`
    if (/^@[^:]+:registry$/u.test(key)) {
      checkRegistry(plain(noEnvironment(value, where), where), where)
      continue
    }
    const name = KEBAB.test(key) ? camelCase(key) : undefined
    if (!(name in READ) || READ[name].rc === false || IGNORED.has(name)) {
      environment ||= fromEnvironment(key) || fromEnvironment(value)
      continue
    }
    noEnvironment(value, where)
    const earlier = settings.get(name)
    if (earlier !== undefined && !(list && earlier.list)) throw new DeptreeError('set more than once', where)
    if (list && READ[name].kind !== 'texts') throw new DeptreeError('not a list', where)
    const next = list ? [...(earlier?.value ?? []), plain(value, where)] : plain(value, where)
    settings.set(name, { value: next, list, where, read: READ[name] })
  }
  return { settings, environment }
}

// The keys of `pnpm` pnpm 10 reads (MANIFEST_KEYS), and the overrides of
// Yarn's `resolutions` and `pnpm.overrides`, the second over the first.
function fromManifest(manifest) {
  const pnpm = manifest.pnpm === undefined ? {} : readers.mapping(manifest.pnpm, 'package.json: pnpm')
  const settings = new Map()
  for (const name of MANIFEST_KEYS) {
    if (!Object.hasOwn(pnpm, name) || name === 'overrides') continue
    const where = `package.json: pnpm.${name}`
    noEnvironment(pnpm[name], where)
    const read = readerOf(name, where, 10)
    if (read !== undefined) settings.set(name, { value: pnpm[name], where, read })
  }
  const { resolutions } = manifest
  if (resolutions !== undefined || Object.hasOwn(pnpm, 'overrides')) {
    const where = 'package.json: resolutions and pnpm.overrides'
    const value = { ...(resolutions === undefined ? {} : readers.mapping(resolutions, 'package.json: resolutions')), ...(Object.hasOwn(pnpm, 'overrides') ? readers.mapping(pnpm.overrides, 'package.json: pnpm.overrides') : {}) }
    settings.set('overrides', { value, where, read: READ.overrides })
  }
  return settings
}

// pnpm 11 passes over a key not in camelCase.
const CAMEL = /^[a-z][\dA-Za-z]*$/u

// pnpm 12 passes over a key with no value. `pinned` is readerOf's.
function fromWorkspace(workspace, major, pinned) {
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) throw new DeptreeError('expected a mapping', 'pnpm-workspace.yaml')
  const settings = new Map()
  for (const [name, value] of Object.entries(workspace)) {
    const where = `pnpm-workspace.yaml: ${name}`
    noEnvironment(name, where)
    noEnvironment(value, where)
    if (major >= 11 && !CAMEL.test(name)) {
      if (major >= 12 && pinned && value !== null && !known12(camelCase(name))) throw unrecognized12(where)
      continue
    }
    const read = readerOf(name, where, major, pinned && value !== null)
    if (read !== undefined) settings.set(name, { value, where, read })
  }
  return settings
}

// The settings as pnpm 10 derives them; a hoist pattern left undefined is
// not hoisted to at all. virtualStoreDirMaxLength is 60 by default on
// Windows alone, which is refused (inputs.js's checkHost).
function derive(get) {
  const shamefullyHoist = get('shamefullyHoist')
  let publicHoistPattern = get('publicHoistPattern') ?? []
  if (shamefullyHoist === true) publicHoistPattern = ['*']
  else if (shamefullyHoist === false || (publicHoistPattern.length === 1 && publicHoistPattern[0] === '')) publicHoistPattern = undefined
  return {
    virtualStoreDirMaxLength: get('virtualStoreDirMaxLength') ?? 120,
    hoistPattern: get('hoist') === false ? undefined : get('hoistPattern') ?? ['*'],
    publicHoistPattern,
    hoistWorkspacePackages: get('hoistWorkspacePackages') ?? true,
    engineStrict: get('engineStrict') ?? false,
    nodeVersion: get('nodeVersion'),
    runtimeNodeVersion: undefined,
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
    linkWorkspacePackages: get('linkWorkspacePackages') ?? false,
    pmOnFail: get('pmOnFail'),
    runtimeOnFail: get('runtimeOnFail'),
    packageImportMethod: get('packageImportMethod') ?? 'auto',
  }
}

// The catalogs by name, `catalog` being `default`, as pnpm has them.
function catalogsOf(catalog, catalogs = {}) {
  if (catalog !== undefined && Object.hasOwn(catalogs, 'default')) {
    throw new DeptreeError('the default catalog is defined twice, as catalog and as catalogs.default', 'pnpm-workspace.yaml: catalog')
  }
  return Object.assign(Object.create(null), catalog === undefined ? {} : { default: catalog }, catalogs)
}

// Each layer over the one before, as `derive` has them.
function settle(layers, manifest) {
  const values = new Map()
  for (const layer of layers) {
    for (const [name, { value, where, read: { kind, check } }] of layer) {
      let read = readers[kind](value, where)
      check?.(read, where)
      if (name === 'overrides') {
        if (Object.keys(read).length === 0) continue
        read = replaceReferences(read, manifest, where)
      }
      values.set(name, read)
    }
  }
  return derive((name) => values.get(name))
}

// `workspace` is pnpm-workspace.yaml as parsed and `npmrc` the .npmrc's
// text, either possibly undefined; `pinned` whether the root package.json
// pins the pnpm that runs (fromWorkspace). Overrides that name nothing
// are none, and leave those below them.
export function readSettings({ workspace, npmrc, manifest, major = 10, pinned = false }) {
  const fromYaml = () => (workspace === undefined ? new Map() : fromWorkspace(workspace, major, pinned))
  // pnpm 11 reads no setting from the package.json, not even `resolutions`.
  if (major >= 11) {
    if (npmrc !== undefined) checkNpmrcRegistries(npmrc)
    const settings = settle([fromYaml()], manifest)
    settings.runtimeNodeVersion = runtimeNode(manifest, settings.runtimeOnFail)
    return settings
  }
  const rc = npmrc === undefined ? { settings: new Map(), environment: false } : fromNpmrc(npmrc)
  const rest = [fromYaml(), fromManifest(manifest)]
  const settings = settle([rc.settings, ...rest], manifest)
  if (rc.environment && JSON.stringify(settings) !== JSON.stringify(settle(rest, manifest))) {
    throw new DeptreeError('a line takes a value from the environment, which pnpm drops the whole file for where it is unset, and the file sets what would change the tree', '.npmrc')
  }
  return settings
}

// The Node the root's devEngines.runtime or engines.runtime pins, for
// nodeVersion where none is set; the first naming a range for Node
// decides, with its version where exact. One to download, which gives the
// range's lowest, is refused.
function runtimeNode(manifest, onFail) {
  for (const field of ['devEngines', 'engines']) {
    const runtime = manifest[field]?.runtime
    if (runtime == null) continue
    const where = `manifests["."].${field}.runtime`
    const runtimes = Array.isArray(runtime) ? runtime : [runtime]
    if (runtimes.some((item) => item === null || typeof item !== 'object')) throw new DeptreeError('expected a mapping or a list of mappings, which pnpm fails on otherwise', where)
    const node = runtimes.find((item) => item.name === 'node')
    if (typeof node?.version !== 'string' || validRange(node.version.trim()) === null) continue
    if ((onFail ?? node.onFail) === 'download') throw new DeptreeError('a Node runtime to download is not supported', where)
    return valid(node.version.trim()) ?? undefined
  }
  return undefined
}
