// Cargo.toml, as far as resolution reads it. Sections that bear on none of
// it, [badges], [lints], [profile], [[bin]] and metadata, are not looked into.

import { matches, parseVersion, parseVersionReq } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { field, optional, orEmpty } from '../shape.js'
import { TomlError } from '../toml/error.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { NIGHTLY, dashed, featureMap, gatherDependencies, readSpec } from './dependency.js'
import { array, boolean, checkCrateName, checkCrateVersion, entries, kind, refuse, string, strings, table } from './shape.js'

const PACKAGE_ONLY = [
  'badges', 'features', 'lib', 'bin', 'example', 'test', 'bench', 'dependencies', 'dev-dependencies',
  'dev_dependencies', 'build-dependencies', 'build_dependencies', 'target', 'lints', 'hints',
]
const TOP = [...PACKAGE_ONLY, 'package', 'project', 'workspace', 'profile', 'patch']
const TOP_REFUSED = { 'cargo-features': `cargo-features, ${NIGHTLY}`, replace: '[replace] is not supported' }
const PACKAGE_REFUSED = {
  metabuild: `metabuild, ${NIGHTLY}`,
  'default-target': `a per-package target, ${NIGHTLY}`,
  'forced-target': `a per-package target, ${NIGHTLY}`,
  'im-a-teapot': `im-a-teapot, ${NIGHTLY}`,
  'cargo-features': 'cargo-features belong at the top of the manifest, and are not supported',
}
const WORKSPACE = ['members', 'exclude', 'default-members', 'resolver', 'metadata', 'package', 'dependencies', 'lints']
const EDITIONS = ['2015', '2018', '2021', '2024']
const FIRST_RUST = { __proto__: null, 2018: '1.31.0', 2021: '1.56.0', 2024: '1.85.0' }
const RESOLVERS = { __proto__: null, 1: 1, 2: 2, 3: 3 }

function readEdition(value, where) {
  if (!EDITIONS.includes(string(value, where))) throw new LockfileError(`${quote(value)} is not an edition: expected one of ${EDITIONS.join(', ')}`, where)
  return value
}

function readResolver(value, where) {
  if (!(string(value, where) in RESOLVERS)) throw new LockfileError(`${quote(value)} is not a resolver: expected "1", "2" or "3"`, where)
  return RESOLVERS[value]
}

// As cargo's RustVersion: a version, or a bare `1` or `1.70`, with no
// pre-release or build metadata; as a version, the parts not given 0.
function rustVersion(text) {
  const version = parseVersion(text)
  if (version !== undefined) return version.pre === '' && version.build === '' ? version : undefined
  const partial = parseVersionReq(text)
  if (partial?.length !== 1 || partial[0].op !== '^' || partial[0].pre !== '' || text.startsWith('^')) return undefined
  const { major, minor, patch } = partial[0]
  return parseVersion(`${major}.${minor ?? 0}.${patch ?? 0}`)
}

function readRustVersion(value, where) {
  if (rustVersion(string(value, where)) === undefined) throw new LockfileError(`${quote(value)} is not a Rust version`, where)
  return value
}

function pathOrFlag(value, where) {
  if (typeof value !== 'boolean' && typeof value !== 'string') throw refuse('true, false or a path', value, where)
  return value
}

function readBuild(value, where) {
  if (Array.isArray(value)) throw new LockfileError(`several build scripts, ${NIGHTLY}`, where)
  return pathOrFlag(value, where)
}

function readPublish(value, where) {
  if (typeof value === 'boolean') return value
  if (!Array.isArray(value)) throw refuse('true, false or registry names', value, where)
  return strings(value, where)
}

// Each key's type in cargo's schema; INHERITABLE's may be `{ workspace = true }`.
const INHERITABLE = {
  authors: strings, categories: strings, description: string, documentation: string, edition: readEdition,
  exclude: strings, homepage: string, include: strings, keywords: strings, license: string, 'license-file': string,
  publish: readPublish, readme: pathOrFlag, repository: string, 'rust-version': readRustVersion, version: checkCrateVersion,
}
const PACKAGE = {
  ...INHERITABLE, name: checkCrateName, build: readBuild, links: string, workspace: string, autolib: boolean, autobins: boolean,
  autoexamples: boolean, autotests: boolean, autobenches: boolean, 'default-run': string, resolver: readResolver, metadata: (value) => value,
}

function readBadges(value, where) {
  for (const [, badge, here] of entries(value, where)) for (const [, item, there] of entries(badge, here)) string(item, there)
  return value
}

// The flag wins over the crate type, as in cargo's Target::proc_macro; a
// library's proc-macro crate type is taken alone.
function procMacroOf(value, where, edition, lib) {
  table(value, where)
  const flag = optional(boolean)(dashed(value, where, 'proc-macro', edition), at(where, 'proc-macro'))
  const types = optional(strings)(dashed(value, where, 'crate-type', edition), at(where, 'crate-type'))
  if (lib && types?.includes('proc-macro') && types.length > 1) throw new LockfileError('a proc-macro crate type is taken alone', at(where, 'crate-type'))
  return flag ?? types?.includes('proc-macro') ?? false
}

function procMacroTargets(doc, edition) {
  const lib = doc.lib !== undefined && procMacroOf(doc.lib, 'lib', edition, true)
  const others = ['example', 'test', 'bench'].flatMap((key) => array(doc[key] ?? [], key).map((item, index) => procMacroOf(item, `${key}[${index}]`, edition, false)))
  return { procMacro: lib, procMacroTarget: lib || others.includes(true) }
}

function readWorkspace(value) {
  table(value, 'workspace', WORKSPACE)
  const read = (key, reader) => field(value, key, 'workspace', reader)
  const pkg = read('package', (item, where) => table(item, where, [...Object.keys(INHERITABLE), 'badges'])) ?? Object.create(null)
  for (const [key, item, here] of entries(pkg, 'workspace.package')) (key === 'badges' ? readBadges : INHERITABLE[key])(item, here)
  const dependencies = Object.create(null)
  for (const [name, item, here] of entries(orEmpty(value.dependencies), 'workspace.dependencies')) {
    checkCrateName(name, here)
    const spec = readSpec(item, here, name)
    if (spec.optional) throw new LockfileError('a workspace dependency cannot be optional', here)
    if (isTable(item) && item.public !== undefined) throw new LockfileError('a workspace dependency cannot be public', here)
    dependencies[name] = spec
  }
  return {
    members: read('members', strings) ?? [],
    exclude: read('exclude', strings) ?? [],
    defaultMembers: read('default-members', strings),
    resolver: read('resolver', readResolver),
    package: pkg,
    dependencies,
  }
}

function readPatch(value, where = 'patch') {
  const patch = Object.create(null)
  for (const [key, deps, here] of entries(orEmpty(value), where)) {
    patch[key] = Object.create(null)
    for (const [name, item, there] of entries(deps, here)) patch[key][checkCrateName(name, there)] = readSpec(item, there, name)
  }
  return patch
}

// Cargo's config merge, `first` the closer: tables key by key, arrays joined
// with the closer's last, and of two other values the closer; a table or
// array against another kind is refused, as cargo refuses it.
function mergeConfig(first, then, where) {
  if (isTable(first) && isTable(then)) {
    const merged = Object.assign(Object.create(null), then)
    for (const [key, value] of Object.entries(first)) merged[key] = Object.hasOwn(then, key) ? mergeConfig(value, then[key], at(where, key)) : value
    return merged
  }
  if (Array.isArray(first) && Array.isArray(then)) return [...then, ...first]
  if ([first, then].some((value) => isTable(value) || Array.isArray(value))) {
    throw new LockfileError(`${kind(first)} in one config and ${kind(then)} in one under it, which cargo does not merge`, where)
  }
  return first
}

// `texts`: the closest config file first, a `--config` value before them all.
export function parseCargoConfig(texts) {
  if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) throw new TypeError('expected the texts of the config files')
  let patch
  for (const [index, text] of texts.entries()) {
    let doc
    try {
      doc = parseToml(text)
    } catch (error) {
      if (error instanceof TomlError) error.message = `texts[${index}]: ${error.message}`
      throw error
    }
    if (doc.patch !== undefined) patch = patch === undefined ? doc.patch : mergeConfig(patch, doc.patch, 'patch')
  }
  return { patch: readPatch(patch) }
}

function inheritField(value, where, key, workspace) {
  if (!isTable(value)) return value
  table(value, where, ['workspace'])
  if (value.workspace !== true) throw refuse('true', value.workspace, at(where, 'workspace'))
  if (workspace === undefined) throw new LockfileError('inherits from a workspace, and no workspace root is given', where)
  if (workspace.package[key] === undefined) throw new LockfileError(`workspace.package.${key} is not given`, where)
  return workspace.package[key]
}

function readPackage(doc, workspace) {
  if (doc.package !== undefined && doc.project !== undefined) throw new LockfileError('[project] beside [package]', 'project')
  const where = doc.package === undefined ? 'project' : 'package'
  const value = table(doc[where], where, Object.keys(PACKAGE), PACKAGE_REFUSED)
  const fields = Object.create(null)
  for (const [key, read] of Object.entries(PACKAGE)) {
    const here = at(where, key)
    fields[key] = optional(read)(key in INHERITABLE ? inheritField(value[key], here, key, workspace) : value[key], here)
  }
  if (value.workspace !== undefined && doc.workspace !== undefined) throw new LockfileError('a workspace root names no other root', at(where, 'workspace'))
  const edition = fields.edition ?? '2015'
  if (where === 'project' && edition === '2024') throw new LockfileError('not supported in the 2024 edition: use [package]', where)
  // Cargo holds rust-version to `^` the edition's first Rust, so 2.0 fails it too.
  const msrv = fields['rust-version']
  if (msrv !== undefined && edition in FIRST_RUST && !matches(parseVersionReq(`^${FIRST_RUST[edition]}`), rustVersion(msrv))) {
    throw new LockfileError(`rust-version ${quote(msrv)} is incompatible with ${FIRST_RUST[edition]}, which the ${edition} edition requires`, at(where, 'rust-version'))
  }
  const { version, publish } = fields
  if (version === undefined && publish !== undefined && publish !== false && !(Array.isArray(publish) && publish.length === 0)) {
    throw new LockfileError('`publish` needs a `version`', at(where, 'publish'))
  }
  const { resolver, links } = fields
  if (resolver !== undefined && doc.workspace?.resolver !== undefined) throw new LockfileError('`resolver` is given in [workspace] too', at(where, 'resolver'))
  if (links !== undefined && fields.build === false) throw new LockfileError(`links to ${quote(links)} with no build script, which cargo refuses`, at(where, 'links'))
  return { name: checkCrateName(value.name, at(where, 'name')), version: version ?? '0.0.0', edition, resolver, links }
}

export function parseCargoManifest(text, workspace) {
  const doc = table(parseToml(text), undefined, TOP, TOP_REFUSED)
  const own = doc.workspace === undefined ? undefined : readWorkspace(doc.workspace)
  if (own !== undefined && workspace !== undefined) throw new LockfileError('a workspace root inherits from its own [workspace], not another', 'workspace')
  if (workspace !== undefined && workspace.workspace === undefined) throw new TypeError('expected the manifest of a workspace root')
  const root = own ?? workspace?.workspace
  const patch = readPatch(doc.patch)
  if (doc.package === undefined && doc.project === undefined) {
    if (own === undefined) throw new LockfileError('neither [package] nor [workspace]')
    const stray = PACKAGE_ONLY.find((key) => doc[key] !== undefined)
    if (stray !== undefined) throw new LockfileError('a virtual manifest has no package for it', stray)
    return { package: undefined, workspace: own, patch }
  }
  const pkg = readPackage(doc, root)
  const dependencies = gatherDependencies(doc, root, pkg.edition)
  const targets = procMacroTargets(doc, pkg.edition)
  return {
    package: { ...pkg, features: featureMap(doc.features, 'features', dependencies), dependencies, ...targets },
    workspace: own,
    patch,
  }
}
