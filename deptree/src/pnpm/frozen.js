// What pnpm 11's frozen install holds each project to beyond what pnpm
// 10's does (@pnpm/lockfile.verification): specifiers that name one git
// repository and commit alike are the same; a catalog dependency has to
// have resolved to the version the lockfile's catalog records; and a
// dependency on a workspace package has to be linked exactly where the
// package's version is in its range — which pnpm 10 checks only when it
// resolves.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { join, normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])
const SHORTCUTS = [['github:', 'github.com'], ['gitlab:', 'gitlab.com'], ['bitbucket:', 'bitbucket.org']]

function gitUrl(host, path, committish) {
  if (path === '' || path.includes('@') || path.includes('?') || /\s/u.test(path) || path.split('/').includes('')) return undefined
  const repository = path.endsWith('.git') ? path.slice(0, -4) : path
  if (repository === '' || repository.endsWith('/')) return undefined
  return `git+https://${host}/${repository}.git${committish ? `#${committish}` : ''}`
}

// A git specifier as one URL, as gitSpecifiersAreEquivalent spells it, or
// undefined for one that is not.
function gitSpecifier(specifier) {
  const hash = specifier.indexOf('#')
  const committish = hash === -1 ? undefined : specifier.slice(hash + 1)
  if (committish?.includes('#')) return undefined
  const repository = hash === -1 ? specifier : specifier.slice(0, hash)
  const shortcut = SHORTCUTS.find(([prefix]) => repository.startsWith(prefix))
  let found
  if (shortcut !== undefined) found = gitUrl(shortcut[1], repository.slice(shortcut[0].length), committish)
  else if (!repository.startsWith('.') && !/[\s:@]/u.test(repository) && repository.split('/').length === 2) found = gitUrl('github.com', repository, committish)
  if (found !== undefined) return found
  const schemeEnd = repository.indexOf('://')
  if (schemeEnd === -1) return undefined
  const scheme = repository.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'git' && scheme !== 'git+https' && scheme !== 'https') return undefined
  const location = repository.slice(schemeEnd + 3)
  const slash = location.indexOf('/')
  if (slash === -1) return undefined
  const host = location.slice(0, slash).toLowerCase()
  const path = location.slice(slash + 1)
  if (host === '' || /[\s?@]/u.test(host) || (scheme === 'https' && !GIT_HOSTS.has(host) && !path.endsWith('.git'))) return undefined
  return gitUrl(host, path, committish)
}

// dependencySpecifiersAreEqual: pnpm 11 takes two specifiers of one git
// repository and commit, however spelled, to be the same; pnpm 10 only
// two spelled the same.
export function sameSpecifier(a, b, major) {
  if (a === b) return true
  if (major < 11 || a === undefined || b === undefined) return false
  const git = gitSpecifier(a)
  return git !== undefined && git === gitSpecifier(b)
}

// The version an importer's target resolved to, as the lockfile spells
// it: a key of the alias's own name is its version and peers.
export const refOf = (alias, target) => (target.startsWith(`${alias}@`) ? target.slice(alias.length + 1) : target)

const targetOf = (importer, alias) => importer.dependencies[alias] ?? importer.devDependencies[alias] ?? importer.optionalDependencies[alias]

// catalogResolutionsAreUpToDate.
export function checkCatalogResolutions(importer, catalogs, where) {
  for (const [alias, specifier] of Object.entries(importer.specifiers)) {
    if (!specifier.startsWith('catalog:')) continue
    const name = specifier.slice('catalog:'.length).trim() || 'default'
    const version = Object.hasOwn(catalogs, name) && Object.hasOwn(catalogs[name], alias) ? catalogs[name][alias].version : undefined
    const target = targetOf(importer, alias)
    if (version === undefined || target === undefined) continue
    const resolved = packageKeyOf(refOf(alias, target))
    if (valid(resolved) !== null && resolved !== version) throw new DeptreeError(`${quote(alias)} resolved to ${quote(resolved)}, and the lockfile's catalog ${quote(name)} to ${quote(version)}, which pnpm 11 refuses a frozen install for`, where)
  }
}

// A path pnpm resolves from a directory, `./` and all, relative to the
// lockfile's directory as the lockfile's links are; one from the home
// directory or the root cannot be told here.
function specPath(dir, path, where) {
  const clean = path.startsWith('./') ? path.slice(2) : path
  if (/^(?:~[/\\]|[/\\]|[A-Za-z]:)/u.test(clean) || clean.includes('\\')) throw new DeptreeError(`${quote(path)} is not a path from the project, which is not supported`, where)
  return normalize(join(dir, clean))
}

const isWorkspacePath = (spec) => /^(?:[./\\]|~[/\\]|[A-Za-z]:)/u.test(spec)
// Of two paths in the lockfile's normal form, whether one is the other or
// in it.
const within = (parent, child) => child === parent || (parent === '.' ? child !== '..' && !child.startsWith('../') : child.startsWith(`${parent}/`))

function targetName(spec, alias) {
  if (spec.startsWith('workspace:')) {
    const raw = spec.slice('workspace:'.length)
    const at = raw.lastIndexOf('@')
    return isWorkspacePath(raw) || at <= 0 ? alias : raw.slice(0, at)
  }
  if (spec.startsWith('npm:')) {
    const raw = spec.slice('npm:'.length)
    if (validRange(raw) !== null) return alias
    const at = raw.lastIndexOf('@')
    return at > 0 ? raw.slice(0, at) : raw
  }
  return alias
}

function versionRange(spec) {
  if (spec.startsWith('workspace:')) {
    const raw = spec.slice('workspace:'.length)
    const at = raw.lastIndexOf('@')
    return at > 0 ? raw.slice(at + 1) || '*' : raw
  }
  if (spec.startsWith('npm:')) {
    const raw = spec.slice('npm:'.length)
    if (validRange(raw) !== null) return raw
    const at = raw.indexOf('@', 1)
    return at === -1 ? '*' : raw.slice(at + 1) || '*'
  }
  return spec
}

const inRange = (version, range) => range === '*' || range === '^' || range === '~' || (typeof version === 'string' && satisfies(version, range, { loose: true }))

// version-selector-type's tag: a name that is no version or range.
const isTag = (range) => valid(range, { loose: true }) === null && validRange(range, { loose: true }) === null && encodeURIComponent(range) === range

const KINDS = ['optionalDependencies', 'dependencies', 'devDependencies']

// checkLinkedPackagesAreUpToDate, for the project at `id`: `manifest` is
// its package.json as read through the read-package hook, `projects`
// every project's by its directory, as given, and `linkWorkspacePackages`
// the setting.
export function checkLinkedPackages({ id, manifest, importer, projects, linkWorkspacePackages }, where) {
  const byName = new Map()
  const byDir = new Map()
  for (const [dir, project] of projects) {
    byDir.set(dir, project)
    const directory = project.publishConfig?.directory
    if (typeof directory === 'string' && project.publishConfig.linkDirectory !== false) byDir.set(normalize(join(dir, directory)), project)
    if (!project.name) continue
    if (!byName.has(project.name)) byName.set(project.name, new Map())
    const version = project.version ?? '0.0.0'
    if (byName.get(project.name).has(version)) throw new DeptreeError(`${quote(String(project.name))} at ${quote(String(version))} is another project's name and version too, which leaves which pnpm 11 checks a dependency against to the order it finds them in`, `manifests[${quote(dir)}]`)
    byName.get(project.name).set(version, dir)
  }
  const outdated = (detail) => new DeptreeError(`the lockfile is not up to date with this package.json, which pnpm 11 refuses a frozen install for: ${detail}`, where)
  for (const kind of KINDS) {
    const wanted = manifest[kind]
    if (wanted == null) continue
    for (const [alias, target] of Object.entries(importer[kind])) {
      const spec = wanted[alias]
      if (!spec) continue
      const here = `${where}.${kind}.${alias}`
      const workspaceRange = spec.startsWith('workspace:') && !isWorkspacePath(spec.slice('workspace:'.length))
      const linked = target.startsWith('link:')
      const local = importer.specifiers[alias].startsWith('file:') || packageKeyOf(target).includes('@file:')
      if (local && !linked) throw new DeptreeError('a dependency on a local directory or tarball is not supported', here)
      if (local) continue
      const linkedTo = linked ? target.slice('link:'.length) : undefined
      const path = spec.startsWith('link:') || spec.startsWith('file:') ? spec.slice(5) : spec.startsWith('workspace:') && !workspaceRange ? spec.slice('workspace:'.length) : undefined
      if (linked && path !== undefined) {
        if (specPath(id, path, here) !== linkedTo) throw outdated(`${alias} is linked to ${quote(linkedTo)}, which is not where ${quote(spec)} leads`)
        continue
      }
      const name = targetName(spec, alias)
      const range = versionRange(spec)
      if (linked && isTag(range)) continue
      const named = byName.get(name)
      const dir = linked ? linkedTo : named?.get(packageKeyOf(refOf(alias, target)))
      if (dir === undefined) {
        const taking = workspaceRange && named !== undefined ? [...named.keys()].find((version) => inRange(projects.get(named.get(version)).version, range)) : undefined
        if (taking !== undefined) throw outdated(`the workspace package ${quote(name)} (${taking}) is in the range ${quote(spec)} and not linked`)
        continue
      }
      if (!linkWorkspacePackages && !spec.startsWith('workspace:')) continue
      if (linked && workspaceRange && named !== undefined && ![...named.values()].some((root) => within(root, dir))) {
        throw outdated(`${alias} is linked to ${quote(dir)}, which is in no workspace package named ${quote(name)}`)
      }
      if (!byDir.has(dir)) throw new DeptreeError(`it is linked to ${quote(dir)}, which is no project, and whose package.json pnpm 11 reads`, here)
      const { version } = byDir.get(dir)
      if (linked !== inRange(version, range)) {
        throw outdated(linked ? `the linked workspace package ${alias} (${version ?? 'unknown'}) is not in the range ${quote(spec)}` : `the workspace package ${alias} (${version ?? 'unknown'}) is in the range ${quote(spec)} and not linked`)
      }
    }
  }
}
