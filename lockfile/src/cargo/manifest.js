// Cargo.toml, for what resolution reads of it: a package's name, version
// and edition, its features, its dependencies and what each asks of the
// package it names, whether its library is a proc-macro, and a workspace
// root's [workspace] and [patch]. Sections that bear on none of that —
// [badges], [lints], [profile], [[bin]], metadata — are not looked into.
//
// What cargo reads and this does not is refused by name: cargo-features,
// [replace], artifact dependencies, path bases, what only a nightly cargo
// takes. So is a key cargo does not know, which it warns of and drops, and
// what cargo refuses in a manifest it reads without a filesystem: a feature
// that names nothing, a dependency with two sources.

import { parseVersion } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { EMPTY } from '../shape.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { NIGHTLY, dashed, featureMap, gatherDependencies, readSpec } from './dependency.js'
import { array, boolean, checkName, entries, optional, refuse, string, strings, table } from './shape.js'

// What only a package has, which a virtual manifest cannot.
const PACKAGE_ONLY = [
  'badges', 'features', 'lib', 'bin', 'example', 'test', 'bench', 'dependencies', 'dev-dependencies',
  'dev_dependencies', 'build-dependencies', 'build_dependencies', 'target', 'lints', 'hints',
]
const TOP = [...PACKAGE_ONLY, 'package', 'project', 'workspace', 'profile', 'patch']
const TOP_REFUSED = { 'cargo-features': `cargo-features, ${NIGHTLY}`, replace: '[replace] is not supported' }
const INHERITABLE = [
  'authors', 'categories', 'description', 'documentation', 'edition', 'exclude', 'homepage', 'include',
  'keywords', 'license', 'license-file', 'publish', 'readme', 'repository', 'rust-version', 'version',
]
const PACKAGE = [
  ...INHERITABLE, 'name', 'build', 'links', 'workspace', 'autolib', 'autobins', 'autoexamples', 'autotests',
  'autobenches', 'default-run', 'resolver', 'metadata',
]
const PACKAGE_REFUSED = {
  metabuild: `metabuild, ${NIGHTLY}`,
  'default-target': `a per-package target, ${NIGHTLY}`,
  'forced-target': `a per-package target, ${NIGHTLY}`,
  'im-a-teapot': `im-a-teapot, ${NIGHTLY}`,
  'cargo-features': 'cargo-features belong at the top of the manifest, and are not supported',
}
const WORKSPACE = ['members', 'exclude', 'default-members', 'resolver', 'metadata', 'package', 'dependencies', 'lints']
const EDITIONS = ['2015', '2018', '2021', '2024']
const RESOLVERS = { __proto__: null, 1: 1, 2: 2, 3: 3 }

function readVersion(value, where) {
  if (parseVersion(string(value, where)) === undefined) throw new LockfileError(`${quote(value)} is not a version`, where)
  return value
}

function readEdition(value, where) {
  if (!EDITIONS.includes(string(value, where))) throw new LockfileError(`${quote(value)} is not an edition: expected one of ${EDITIONS.join(', ')}`, where)
  return value
}

function readResolver(value, where) {
  if (!(string(value, where) in RESOLVERS)) throw new LockfileError(`${quote(value)} is not a resolver: expected "1", "2" or "3"`, where)
  return RESOLVERS[value]
}

// Whether a target is a proc-macro: `proc-macro = true`, or a crate type
// of `proc-macro`, which the library takes alone.
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
  const read = (key, reader) => optional(reader)(value[key], at('workspace', key))
  const pkg = read('package', (item, where) => table(item, where, [...INHERITABLE, 'badges'])) ?? Object.create(null)
  if (pkg.version !== undefined) readVersion(pkg.version, 'workspace.package.version')
  if (pkg.edition !== undefined) readEdition(pkg.edition, 'workspace.package.edition')
  const dependencies = Object.create(null)
  for (const [name, item, here] of entries(value.dependencies ?? EMPTY, 'workspace.dependencies')) {
    checkName(name, here)
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

function readPatch(value) {
  const patch = Object.create(null)
  for (const [key, deps, here] of entries(value ?? EMPTY, 'patch')) {
    patch[key] = Object.create(null)
    for (const [name, item, there] of entries(deps, here)) patch[key][checkName(name, there)] = readSpec(item, there, name)
  }
  return patch
}

// A field given as `{ workspace = true }`, from [workspace.package].
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
  const value = table(doc[where], where, PACKAGE, PACKAGE_REFUSED)
  if (value.workspace !== undefined && doc.workspace !== undefined) throw new LockfileError('a workspace root names no other root', at(where, 'workspace'))
  const fields = Object.fromEntries(INHERITABLE.map((key) => [key, inheritField(value[key], at(where, key), key, workspace)]))
  const edition = optional(readEdition)(fields.edition, at(where, 'edition')) ?? '2015'
  if (where === 'project' && edition === '2024') throw new LockfileError('not supported in the 2024 edition: use [package]', where)
  const version = optional(readVersion)(fields.version, at(where, 'version'))
  const { publish } = fields
  if (version === undefined && publish !== undefined && publish !== false && !(Array.isArray(publish) && publish.length === 0)) {
    throw new LockfileError('`publish` needs a `version`', at(where, 'publish'))
  }
  const resolver = optional(readResolver)(value.resolver, at(where, 'resolver'))
  if (resolver !== undefined && doc.workspace?.resolver !== undefined) throw new LockfileError('`resolver` is given in [workspace] too', at(where, 'resolver'))
  const links = optional(string)(value.links, at(where, 'links'))
  if (links !== undefined && value.build === false) throw new LockfileError(`links to ${quote(links)} with no build script, which cargo refuses`, at(where, 'links'))
  return { name: checkName(value.name, at(where, 'name')), version: version ?? '0.0.0', edition, resolver, links }
}

// `workspace` is the root's manifest, read before, for a member that
// inherits from it; a root inherits from its own [workspace].
export function parseCargoManifest(text, workspace) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
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
