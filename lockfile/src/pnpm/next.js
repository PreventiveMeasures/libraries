// A lockfile of `lockfileVersion: '13.0'`, which pnpm 12 writes from 12.19.0
// with `lockfile.format: v13` (@pnpm/lockfile, next_format), read into the
// v9 document pnpm holds it as, for parse.js to read as it reads a v9 one:
// pnpm keeps a lockfile with v9's keys in memory whichever it writes, and
// it is that it installs from. It is read as pnpm 12.20 and later read it;
// 12.19 reads a reference's bindings as versions alone, and where several
// snapshots have them takes the first, rather than the one of the fewest
// bindings.
//
// What v9 has as sections of their own is in `settings`, `importers` are
// `projects`, a dependency whose version follows from its specifier is the
// specifier alone, and `packages` are one entry per package, with its
// snapshots, keyed and referred to with no peers (next-packages.js).

import { LockfileError, at, quote } from '../error.js'
import { packageKeyOf } from './key.js'
import { checkName, checkRelative } from '../names.js'
import { isMapping, kind as kindOf, mapping, orEmpty, record, string, text } from '../shape.js'
import { readEntry, readWith, refVersion } from './next-packages.js'
import { byCodePoint } from './restore.js'
import { restoreSections } from './restore-keys.js'

const FIELDS = ['lockfileVersion', 'settings', 'projects', 'packages', 'time']
const SETTINGS = ['autoInstallPeers', 'dedupePeers', 'excludeLinksFromLockfile', 'injectWorkspacePackages', 'peersSuffixMaxLength']
const RECORDS = ['catalogs', 'overrides', 'patchedDependencies', 'packageExtensionsChecksum', 'pnpmfileChecksum', 'ignoredOptionalDependencies']
const PROJECT = ['name', 'dependencies', 'devDependencies', 'optionalDependencies', 'dependenciesMeta', 'publishDirectory', 'linkDirectory']
const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// The package of an `npm:` alias's target, `name` or `name@range`.
const aliasName = (target) => (target.indexOf('@', 1) === -1 ? target : target.slice(0, target.indexOf('@', 1)))

// The version a catalog entry's specifier implies: the specifier, or the
// version of an `npm:` alias, which a catalog records bare.
function catalogVersion(specifier) {
  if (!specifier.startsWith('npm:')) return specifier
  const target = specifier.slice(4)
  const sep = target.indexOf('@', 1)
  return sep === -1 ? undefined : target.slice(sep + 1)
}

// By catalog and name, `{specifier, version}`, as v9 writes them.
const readCatalogs = (value, where) => mapping(orEmpty(value), where, (names, here) => mapping(names, here, (item, there) => {
  if (!isMapping(item)) {
    const version = catalogVersion(text(item, there))
    if (version === undefined) throw new LockfileError(`no version follows from ${quote(item)}`, there)
    return { specifier: item, version }
  }
  record(item, there, ['specifier', 'version'])
  if (catalogVersion(string(item.specifier, at(there, 'specifier'))) === item.version) throw new LockfileError('expected the specifier alone, as pnpm writes an entry whose version follows from it', there)
  return item
}))

// What follows a `workspace:` specifier's version from: the path of each
// package of a single `name@file:<path>` key, and each project's id by the
// name it records, where one name is one project's.
function injectedPaths(keys) {
  const paths = new Map()
  for (const key of keys) {
    const sep = key.indexOf('@', 1)
    if (!key.startsWith('file:', sep + 1)) continue
    const name = key.slice(0, sep)
    paths.set(name, paths.has(name) ? undefined : key.slice(sep + 6))
  }
  return paths
}

function oneToOne(claims) {
  const byName = new Map(claims.entries().filter(([, id]) => id !== undefined))
  const ids = [...byName.values()]
  return new Map(byName.entries().filter(([, id]) => ids.indexOf(id) === ids.lastIndexOf(id)))
}

const claim = (claims, name, id) => claims.set(name, claims.has(name) && claims.get(name) !== id ? undefined : id)

const segmentsOf = (id) => id.split('/').filter((segment) => segment !== '' && segment !== '.')
function linkPath(from, to) {
  const [a, b] = [segmentsOf(from), segmentsOf(to)]
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return [...Array.from({ length: a.length - common }, () => '..'), ...b.slice(common)].join('/') || '.'
}

function linkTarget(id, link) {
  const path = segmentsOf(id)
  for (const segment of link.split('/')) {
    if (segment === '..') {
      if (path.pop() === undefined) return undefined
    } else if (segment !== '' && segment !== '.') {
      path.push(segment)
    }
  }
  return path.join('/') || '.'
}

const workspaceName = (target) => (target.indexOf('@', 1) === -1 ? undefined : target.slice(0, target.indexOf('@', 1)))

// The version a specifier implies, as pnpm's implied_version has it: an
// exact version itself, `npm:` its target, a `catalog:` its entry's, a
// `workspace:` the injected package's `file:` or the linked project's
// `link:`; undefined for a `workspace:` that is neither or both, or a
// catalog that has no such entry.
function implied(context, id, alias, specifier) {
  if (specifier.startsWith('workspace:')) {
    const name = workspaceName(specifier.slice(10))
    const pkg = name ?? alias
    const [path, project] = [context.injected.get(pkg), context.linked.get(pkg)]
    if ((path === undefined) === (project === undefined)) return undefined
    if (project !== undefined) return `link:${linkPath(id, project)}`
    return name !== undefined && name !== alias ? `${name}@file:${path}` : `file:${path}`
  }
  if (specifier.startsWith('catalog:')) {
    const entry = context.catalogs[specifier.slice(8) || 'default']?.[alias]
    if (entry === undefined) return undefined
    return entry.specifier.startsWith('npm:') ? `${aliasName(entry.specifier.slice(4))}@${entry.version}` : entry.version
  }
  return specifier.startsWith('npm:') ? specifier.slice(4) : specifier
}

function readDependency(value, where, alias) {
  if (!isMapping(value)) return { specifier: text(value, where), version: undefined, with: undefined }
  record(value, where, ['specifier', 'version', 'with'])
  if (value.version === undefined && value.with === undefined) throw new LockfileError('expected the specifier alone, as pnpm writes a dependency it says nothing more of', where)
  return {
    specifier: string(value.specifier, at(where, 'specifier')),
    version: value.version === undefined ? undefined : readImporterVersion(value.version, at(where, 'version'), alias),
    with: value.with === undefined ? undefined : readWith(value.with, at(where, 'with')),
  }
}

const readImporterVersion = (value, where, alias) => refVersion(value, where, checkName(alias, where))

// Each project, its dependencies by kind and alias, each with its version.
function readProjects(value, where, context) {
  const projects = new Map()
  for (const [id, project] of Object.entries(record(orEmpty(value), where))) {
    const here = at(where, id)
    checkRelative(id, here)
    record(project, here, PROJECT)
    const kinds = Object.fromEntries(KINDS.map((kind) => [kind, mapping(orEmpty(project[kind]), at(here, kind), readDependency)]))
    projects.set(id, { project, kinds, name: project.name === undefined ? undefined : text(project.name, at(here, 'name')) })
  }
  context.linked = oneToOne(projects.entries().reduce((claims, [id, { name }]) => (name === undefined ? claims : claim(claims, name, id)), new Map()))
  for (const [id, { kinds }] of projects) {
    for (const kind of KINDS) {
      for (const [alias, dep] of Object.entries(kinds[kind])) {
        const there = at(at(at(where, id), kind), alias)
        const follows = implied(context, id, alias, dep.specifier)
        if (dep.version === undefined && follows === undefined) throw new LockfileError(`no version follows from ${quote(dep.specifier)}`, there)
        if (dep.version !== undefined && dep.version === follows) throw new LockfileError('expected the specifier alone, as pnpm writes a dependency whose version follows from it', there)
        dep.version ??= readImporterVersion(follows, there, alias)
      }
    }
  }
  checkNames(projects, where)
  return projects
}

// pnpm records a project's name exactly where a `workspace:` dependency of a
// project links to it, by the name the dependency gives it.
function checkNames(projects, where) {
  const claims = new Map()
  for (const [id, { kinds }] of projects) {
    for (const [alias, dep] of KINDS.flatMap((kind) => Object.entries(kinds[kind]))) {
      if (!dep.specifier.startsWith('workspace:') || !dep.version.startsWith('link:')) continue
      const target = linkTarget(id, dep.version.slice(5))
      if (target !== undefined && projects.has(target)) claim(claims, workspaceName(dep.specifier.slice(10)) ?? alias, target)
    }
  }
  const names = new Map(oneToOne(claims).entries().map(([name, id]) => [id, name]))
  for (const [id, { name }] of projects) {
    if (name !== names.get(id)) throw new LockfileError(name === undefined ? `expected the name ${quote(names.get(id))}, which a workspace: dependency links it by` : 'no workspace: dependency links to it by this name', at(at(where, id), 'name'))
  }
}

function v9Importer({ project, kinds }, versions) {
  const importer = Object.create(null)
  for (const kind of KINDS) {
    if (project[kind] === undefined) continue
    importer[kind] = Object.fromEntries(Object.entries(kinds[kind]).toSorted(([a], [b]) => byCodePoint(a, b)).map(([alias, dep]) => [alias, { specifier: dep.specifier, version: versions.get(alias) }]))
  }
  for (const name of ['dependenciesMeta', 'publishDirectory', 'linkDirectory']) if (project[name] !== undefined) importer[name] = project[name]
  return importer
}

// The document as the v9 one pnpm holds in memory for it, in the shape
// the YAML of one reads to.
export function fromNext(doc) {
  const version = record(doc, undefined).lockfileVersion
  if (version !== '13.0') throw new LockfileError(`unsupported version: expected "13.0", found ${kindOf(version)}, as pnpm writes a lockfile in JSON of 13.0 alone`, 'lockfileVersion')
  record(doc, undefined, FIELDS)
  const settings = record(orEmpty(doc.settings), 'settings', [...SETTINGS, ...RECORDS])
  const catalogs = readCatalogs(settings.catalogs, 'settings.catalogs')
  const patches = new Map(Object.entries(record(orEmpty(settings.patchedDependencies), 'settings.patchedDependencies')))
  const packages = new Map(Object.entries(record(orEmpty(doc.packages), 'packages')).map(([key, entry]) => [key, readEntry(key, entry, at('packages', key))]))
  const context = { catalogs, injected: injectedPaths(packages.keys()), linked: new Map() }
  const projects = readProjects(doc.projects, 'projects', context)
  for (const [id, { kinds }] of projects) {
    const both = KINDS.flatMap((kind) => Object.keys(kinds[kind])).find((alias, index, all) => all.indexOf(alias) !== index)
    if (both !== undefined) throw new LockfileError('listed under two kinds of dependency', at(at('projects', id), both))
  }
  const importers = new Map(projects.entries().map(([id, { kinds }]) => [id, { byAlias: new Map(KINDS.flatMap((kind) => Object.entries(kinds[kind]))) }]))
  const restored = restoreSections(packages, importers, settings, patches)
  const snapshots = Object.create(null)
  for (const [key, entry] of restored.snapshots.toSorted(([a], [b]) => byCodePoint(a, b))) {
    if (key in snapshots) throw new LockfileError(`two snapshots of a package are both read as ${quote(key)}`, at('packages', packageKeyOf(key)))
    snapshots[key] = entry
  }
  const v9 = Object.create(null)
  v9.lockfileVersion = '13.0'
  const base = Object.fromEntries(SETTINGS.filter((name) => settings[name] !== undefined).map((name) => [name, settings[name]]))
  if (Object.keys(base).length > 0) v9.settings = base
  if (settings.catalogs !== undefined) v9.catalogs = catalogs
  for (const name of RECORDS.slice(1)) if (settings[name] !== undefined) v9[name] = settings[name]
  v9.importers = Object.fromEntries(projects.entries().map(([id, project]) => [id, v9Importer(project, restored.versions.get(id))]))
  v9.packages = Object.fromEntries(packages.entries().map(([key, { info }]) => [key, info]))
  v9.snapshots = snapshots
  if (doc.time !== undefined) v9.time = doc.time
  return v9
}

// A refusal of the v9 document fromNext made, placed where the lockfile has
// what it is about: `importers` are `projects`, the sections `settings`
// holds are under it, and a snapshot is of its package's entry.
export function placeNext(error, v9) {
  if (!(error instanceof LockfileError) || error.where === undefined) return error
  const detail = error.message.slice(error.where.length + 2)
  const { where } = error
  const section = /^[A-Za-z]*/u.exec(where)[0]
  const rest = where.slice(section.length)
  if (section === 'importers') return new LockfileError(detail, `projects${rest}`)
  if (RECORDS.includes(section)) return new LockfileError(detail, `settings.${where}`)
  if (section !== 'snapshots') return error
  const key = Object.keys(v9.snapshots).find((name) => where === at('snapshots', name) || where.startsWith(`${at('snapshots', name)}.`) || where.startsWith(`${at('snapshots', name)}[`))
  return key === undefined ? error : new LockfileError(detail, at('packages', packageKeyOf(key)))
}
