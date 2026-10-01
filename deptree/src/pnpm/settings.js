// The settings a pnpm 10 install reads from the .npmrc beside the lockfile,
// from pnpm-workspace.yaml, and from the root package.json's `pnpm` field,
// each over the one before: `pnpm install` spreads what the package.json
// sets over the config it read the others into, so there the package.json
// wins, whatever pnpm's config alone would say.
// In pnpm-workspace.yaml and the package.json, every key is one of three
// things (readers.js): a setting read here, and held to the values this
// package builds a tree for; a setting that leaves the tree as it is,
// whether because a frozen lockfile already says what it would have
// changed, because it is about the network, the store, a cache, a script
// or a bin — no script is ever run, whatever a setting allows — or because
// it is a credential; or anything else, which is refused by name, as is a
// value read here that this package does not build for.
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
//
// pnpm 11 reads its settings from pnpm-workspace.yaml alone: an .npmrc
// for credentials and registries, and the package.json for none but the
// Node its engines.runtime pins, which it takes for nodeVersion. Of the
// yaml it passes over a key not in camelCase, and one about the machine,
// the run or a login; it has settings pnpm 10 has not (READ_11, IGNORED_11),
// and reads linkWorkspacePackages for a frozen install too.

import { valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from './npmrc.js'
import { replaceReferences } from './overrides.js'
import { IGNORED, MANIFEST_KEYS, READ, checkRegistry, readerOf, readers } from './readers.js'

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

// An .npmrc's settings by name, each written once, or once with `[]` each
// time, and whether any line takes something from the environment. A
// registry for a scope has to be the public one.
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

function fromWorkspace(workspace, major) {
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) throw new DeptreeError('expected a mapping', 'pnpm-workspace.yaml')
  const settings = new Map()
  for (const [name, value] of Object.entries(workspace)) {
    const where = `pnpm-workspace.yaml: ${name}`
    noEnvironment(name, where)
    noEnvironment(value, where)
    if (major >= 11 && !CAMEL.test(name)) continue
    const read = readerOf(name, where, major)
    if (read !== undefined) settings.set(name, { value, where, read })
  }
  return settings
}

// The settings as pnpm 10 derives what it installs by: `hoist: false`
// drops the private pattern, `shamefullyHoist` sets or drops the public
// one, and an empty public pattern is none. A pattern left undefined is
// not hoisted to at all. virtualStoreDirMaxLength is 60 by default on
// Windows alone, which is refused (tree.js's checkHost).
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

// The catalogs by name, `catalog` being `default`, as pnpm has them, which
// refuses the default one written both ways.
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

// `workspace` is pnpm-workspace.yaml as parsed and `npmrc` the text of the
// .npmrc, either of which may be undefined; `manifest` the root
// package.json as parsed. Overrides that name nothing are none, and leave
// those below them.
export function readSettings({ workspace, npmrc, manifest, major = 10 }) {
  const fromYaml = () => (workspace === undefined ? new Map() : fromWorkspace(workspace, major))
  // pnpm 11 reads its settings from pnpm-workspace.yaml alone, and none
  // from the package.json, its `resolutions` none.
  if (major >= 11) {
    if (npmrc !== undefined) checkNpmrcRegistries(npmrc)
    const settings = settle([fromYaml()], manifest)
    settings.nodeVersion ??= runtimeNode(manifest, settings.runtimeOnFail)
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

// The Node the root package.json's devEngines.runtime or engines.runtime
// pins, which pnpm 11 takes for nodeVersion where none is set: the first
// that names a range for Node decides, and gives its version where that is
// exact. One to download, which gives the range's lowest, is refused;
// runtimeOnFail stands for each one's onFail.
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
