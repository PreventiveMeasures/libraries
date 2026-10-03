// What pnpm 11's frozen install checks of each project that pnpm 10 checks only
// when it resolves (@pnpm/lockfile.verification).

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { own } from '../manifest.js'
import { within } from '../mount.js'
import { catalogEntry, catalogOf } from './overrides.js'

const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])
const SHORTCUTS = [['github:', 'github.com'], ['gitlab:', 'gitlab.com'], ['bitbucket:', 'bitbucket.org']]

function gitUrl(host, path, committish) {
  if (path === '' || path.includes('@') || path.includes('?') || /\s/u.test(path) || path.split('/').includes('')) return undefined
  const repository = path.endsWith('.git') ? path.slice(0, -4) : path
  if (repository === '' || repository.endsWith('/')) return undefined
  return `git+https://${host}/${repository}.git${committish ? `#${committish}` : ''}`
}

// A git specifier as one URL, as gitSpecifiersAreEquivalent spells it.
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

// dependencySpecifiersAreEqual: pnpm 11 matches git specifiers however spelled.
export function sameSpecifier(a, b, major) {
  if (a === b) return true
  if (major < 11 || a === undefined || b === undefined) return false
  const git = gitSpecifier(a)
  return git !== undefined && git === gitSpecifier(b)
}

// A target under the alias's own name is spelled as its version alone.
export const resolvedOf = (alias, target) => packageKeyOf(target.startsWith(`${alias}@`) ? target.slice(alias.length + 1) : target)

const targetOf = (importer, alias) => importer.dependencies[alias] ?? importer.devDependencies[alias] ?? importer.optionalDependencies[alias]

// catalogResolutionsAreUpToDate.
export function checkCatalogResolutions(importer, catalogs, where) {
  for (const [alias, specifier] of Object.entries(importer.specifiers)) {
    const name = catalogOf(specifier)
    if (name === undefined) continue
    const version = catalogEntry(catalogs, name, alias)?.version
    const target = targetOf(importer, alias)
    if (version === undefined || target === undefined) continue
    const resolved = resolvedOf(alias, target)
    if (valid(resolved) !== null && resolved !== version) throw new DeptreeError(`${quote(alias)} resolved to ${quote(resolved)}, and the lockfile's catalog ${quote(name)} to ${quote(version)}, which pnpm 11 refuses a frozen install for`, where)
  }
}

// Relative to the lockfile's directory, as the lockfile's links are.
function specPath(dir, path, where) {
  const clean = path.startsWith('./') ? path.slice(2) : path
  if (/^(?:~[/\\]|[/\\]|[A-Za-z]:)/u.test(clean) || clean.includes('\\')) throw new DeptreeError(`${quote(path)} is not a path from the project, which is not supported`, where)
  return join(dir, clean.replace(/\/+$/u, ''))
}

const isWorkspacePath = (spec) => /^(?:[./\\]|~[/\\]|[A-Za-z]:)/u.test(spec)

export function parseSpec(spec, alias) {
  if (spec.startsWith('workspace:')) {
    const raw = spec.slice('workspace:'.length)
    const at = raw.lastIndexOf('@')
    return { name: isWorkspacePath(raw) || at <= 0 ? alias : raw.slice(0, at), range: at > 0 ? raw.slice(at + 1) || '*' : raw }
  }
  if (spec.startsWith('npm:')) {
    const raw = spec.slice('npm:'.length)
    if (validRange(raw) !== null) return { name: alias, range: raw }
    const last = raw.lastIndexOf('@')
    const first = raw.indexOf('@', 1)
    return { name: last > 0 ? raw.slice(0, last) : raw, range: first === -1 ? '*' : raw.slice(first + 1) || '*' }
  }
  return { name: alias, range: spec }
}

const inRange = (version, range) => range === '*' || range === '^' || range === '~' || (typeof version === 'string' && satisfies(version, range, { loose: true }))

// version-selector-type's tag: a name that is no version or range.
const isTag = (range) => valid(range, { loose: true }) === null && validRange(range, { loose: true }) === null && encodeURIComponent(range) === range

export const KINDS = ['optionalDependencies', 'dependencies', 'devDependencies']

// A path led by a backslash, a path only on Windows, is taken too for specPath
// to refuse, as a lockfile pnpm writes elsewhere never links it.
function pathOf(spec) {
  if (spec.startsWith('link:') || spec.startsWith('file:')) return spec.slice(5)
  const path = spec.startsWith('workspace:') ? spec.slice('workspace:'.length) : spec
  return isWorkspacePath(path) ? path : undefined
}

// Stricter than pnpm, which checks only a `link:` or `workspace:` path, and
// only from pnpm 11: a lockfile pnpm writes always links where the hooked
// package.json names a directory.
export function checkLinkTargets({ id, manifest, importer }, where) {
  for (const kind of KINDS) {
    for (const [alias, target] of Object.entries(importer[kind])) {
      const spec = own(manifest[kind], alias)
      if (!spec || !target.startsWith('link:') || importer.specifiers[alias].startsWith('file:')) continue
      const path = pathOf(spec)
      const linkedTo = target.slice('link:'.length)
      if (path !== undefined && specPath(id, path, `${where}.${kind}.${alias}`) !== linkedTo) {
        throw new DeptreeError(`the lockfile is not up to date with this package.json, which a frozen install refuses: ${alias} is linked to ${quote(linkedTo)}, which is not where ${quote(spec)} leads`, where)
      }
    }
  }
}

// pnpm 11 links a project from its publishConfig.directory too.
export function indexProjects(projects) {
  const byName = new Map()
  const byDir = new Map()
  for (const [dir, project] of projects) {
    byDir.set(dir, project)
    const directory = project.publishConfig?.directory
    if (typeof directory === 'string' && project.publishConfig.linkDirectory !== false) byDir.set(join(dir, directory), project)
    if (!project.name) continue
    if (!byName.has(project.name)) byName.set(project.name, new Map())
    const version = project.version ?? '0.0.0'
    if (byName.get(project.name).has(version)) throw new DeptreeError(`${quote(String(project.name))} at ${quote(String(version))} is another project's name and version too, which leaves which pnpm 11 checks a dependency against to the order it finds them in`, `manifests[${quote(dir)}]`)
    byName.get(project.name).set(version, dir)
  }
  return { projects, byName, byDir }
}

// checkLinkedPackagesAreUpToDate on the hooked package.json, less the
// directories it names, which checkLinkTargets checks.
export function checkLinkedPackages({ manifest, importer, index: { projects, byName, byDir }, linkWorkspacePackages }, where) {
  const outdated = (detail) => new DeptreeError(`the lockfile is not up to date with this package.json, which pnpm 11 refuses a frozen install for: ${detail}`, where)
  for (const kind of KINDS) {
    for (const [alias, target] of Object.entries(importer[kind])) {
      const spec = own(manifest[kind], alias)
      if (!spec) continue
      const workspaceRange = spec.startsWith('workspace:') && !isWorkspacePath(spec.slice('workspace:'.length))
      const linked = target.startsWith('link:')
      // pnpm 11's frozen install skips a local directory or tarball.
      if (importer.specifiers[alias].startsWith('file:') || packageKeyOf(target).includes('@file:')) continue
      if (linked && pathOf(spec) !== undefined) continue
      const { name, range } = parseSpec(spec, alias)
      if (linked && isTag(range)) continue
      const named = byName.get(name)
      const dir = linked ? target.slice('link:'.length) : named?.get(resolvedOf(alias, target))
      if (dir === undefined) {
        const taking = workspaceRange && named !== undefined ? [...named.keys()].find((version) => inRange(projects.get(named.get(version)).version, range)) : undefined
        if (taking !== undefined) throw outdated(`the workspace package ${quote(name)} (${taking}) is in the range ${quote(spec)} and not linked`)
        continue
      }
      if (!linkWorkspacePackages && !spec.startsWith('workspace:')) continue
      if (linked && workspaceRange && named !== undefined && ![...named.values()].some((root) => within(root, dir))) {
        throw outdated(`${alias} is linked to ${quote(dir)}, which is in no workspace package named ${quote(name)}`)
      }
      if (!byDir.has(dir)) throw new DeptreeError(`it is linked to ${quote(dir)}, which is no project, and whose package.json pnpm 11 reads`, `${where}.${kind}.${alias}`)
      const { version } = byDir.get(dir)
      if (linked !== inRange(version, range)) {
        throw outdated(linked ? `the linked workspace package ${alias} (${version ?? 'unknown'}) is not in the range ${quote(spec)}` : `the workspace package ${alias} (${version ?? 'unknown'}) is in the range ${quote(spec)} and not linked`)
      }
    }
  }
}
