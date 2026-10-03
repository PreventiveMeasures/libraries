// What `composer install` makes of the packages it reads from a lockfile
// before it installs one: the pool Locker::getLockedRepository loads, each
// package with the aliases ArrayLoader gives it of its branch, and the
// root's from `aliases`, beside the root package where composer.json is
// given; and the solver's check, every package fixed and the platform left
// aside, that each is a stability the lockfile takes, that each
// requirement is met by a package, an alias, a provide or a replace there,
// that no conflict meets one, and that no name is had by two; and, of the
// root, Locker::getMissingRequirementInfo's. A lockfile Composer would
// refuse, or install from otherwise, is refused; what is left is each
// requirement and what meets it.

import { LockfileError, at, quote } from '../error.js'
import { keysOf } from './json.js'
import { LINKS, isPlatform } from './package.js'
import { lower } from './php.js'
import { WHERE } from './root.js'
import { DEFAULT_BRANCH_ALIAS, exactly, matches, normalizeBranch, parseNumericAliasPrefix, parseStability } from './semver.js'

export const STABILITIES = { stable: 0, RC: 5, beta: 10, alpha: 15, dev: 20 }

// AliasPackage: the package at another version, of whose links any of
// `self.version` is of that version, and of a conflict, a provide or a
// replace, of both.
function aliasOf(base, version, pretty, root) {
  const links = Object.create(null)
  const isSelf = (link) => link.pretty === 'self.version'
  const own = (link) => ({ ...link, constraint: exactly(version) })
  for (const field of Object.keys(LINKS)) {
    const both = field === 'conflict' || field === 'provide' || field === 'replace'
    links[field] = both ? [...base.links[field], ...base.links[field].filter(isSelf).map(own)] : base.links[field].map((link) => (isSelf(link) ? own(link) : link))
  }
  const selfVersionRequires = base.links.require.some(isSelf)
  return { name: base.name, version, exact: exactly(version), pretty, stability: parseStability(version), links, alias: root ? 'root' : 'branch', base, selfVersionRequires, where: base.where }
}

// ArrayLoader::getBranchAlias, of a dev version: the first of extra's
// branch-alias for it, or 9999999-dev for the default branch, where its
// name is not a number. A target that is not a string ArrayLoader cannot
// read, where it gets to it.
function branchAlias(pkg, where) {
  const { version } = pkg
  if (!version.startsWith('dev-') && !version.endsWith('-dev')) return undefined
  const aliases = pkg.extra?.['branch-alias']
  if (typeof aliases === 'object' && aliases !== null) {
    for (const source of keysOf(aliases)) {
      const target = aliases[source]
      if (typeof target !== 'string') throw new LockfileError('expected a string, as Composer reads a branch alias of a dev version', at(at(at(where, 'extra'), 'branch-alias'), source))
      if (!target.endsWith('-dev')) continue
      const validated = target === DEFAULT_BRANCH_ALIAS ? target : normalizeBranch(target.slice(0, -4))
      if (!validated.endsWith('-dev') || lower(version) !== lower(source)) continue
      const sourcePrefix = parseNumericAliasPrefix(source)
      const targetPrefix = parseNumericAliasPrefix(target)
      if (sourcePrefix !== undefined && targetPrefix !== undefined && !lower(targetPrefix).startsWith(lower(sourcePrefix))) continue
      return validated
    }
  }
  if (pkg.defaultBranch && parseNumericAliasPrefix(version.replace(/^v/u, '')) === undefined) return DEFAULT_BRANCH_ALIAS
  return undefined
}

// BasePackage::getNames: its own, and what it provides, where asked, and
// replaces.
function namesOf(entry, withProvides) {
  const names = new Set([entry.name])
  if (withProvides) for (const link of entry.links.provide) names.add(link.target)
  for (const link of entry.links.replace) names.add(link.target)
  return names
}

// Pool::match. The root's version is any where composer.json gives none.
function provides(entry, name, constraint) {
  if (entry.name === name) return entry.exact === undefined || matches(constraint, entry.exact)
  const meets = (link) => link.target === name && matches(constraint, link.constraint)
  return entry.links.provide.some(meets) || entry.links.replace.some(meets)
}

// The packages installed together, and Pool's index of them by each of
// their names, in their order.
function poolOf(entries) {
  const byName = new Map()
  for (const entry of entries) {
    for (const name of namesOf(entry, true)) (byName.get(name) ?? byName.set(name, []).get(name)).push(entry)
  }
  return { entries, byName, provided: new Map() }
}

const named = (pool, name) => pool.byName.get(name) ?? []

// Pool::whatProvides of a link, once for each link.
function whatProvides(pool, link) {
  if (!pool.provided.has(link)) pool.provided.set(link, named(pool, link.target).filter((entry) => provides(entry, link.target, link.constraint)))
  return pool.provided.get(link)
}

function describe(entry) {
  if (entry.root) return 'the root'
  return `${entry.base?.pkg.name ?? entry.pkg.name} ${entry.alias === undefined ? entry.pkg.version : `${entry.pretty}, an alias of ${entry.base.pkg.version}`}`
}

// StabilityFilter::isPackageAcceptable: by the flag of any of its names that
// has one, or by minimum-stability for one that has none.
function acceptable(entry, minimum, flags) {
  const stability = STABILITIES[entry.stability]
  return [...namesOf(entry, true)].some((name) => stability <= STABILITIES[Object.hasOwn(flags, name) ? flags[name] : minimum])
}

// Two of one name, or of a name one replaces, Composer installs neither of.
function checkNames(bases) {
  const owners = new Map()
  for (const entry of bases) {
    for (const name of namesOf(entry, false)) {
      const owner = owners.get(name)
      if (owner !== undefined) {
        const of = owner.root ? 'the root' : owner.where
        const detail = name === entry.name && name === owner.name ? `listed twice, first as ${of}` : `${quote(name)} is ${name === owner.name ? 'the name' : 'replaced by'} of ${of}, and ${name === entry.name ? 'its name' : 'replaced by it'} too, which Composer installs neither of`
        throw new LockfileError(detail, entry.where)
      }
      owners.set(name, entry)
    }
  }
}

// Of each package, or of an alias where `self.version` makes its own; what
// else of the name the lockfile has, of `everything`, is told.
function checkRequires(entries, pool, mode, everything) {
  for (const entry of entries) {
    if (entry.alias !== undefined && !entry.selfVersionRequires) continue
    for (const link of entry.links.require) {
      if (isPlatform(link.target) || whatProvides(pool, link).length > 0) continue
      const others = named(everything, link.target).filter((other) => !other.root)
      const asked = entry.alias === undefined ? '' : `, as its alias ${entry.pretty} asks for ${link.target} at it`
      const has = others.length === 0 ? '' : `, of ${others.map(describe).join(', ')}, which the lockfile has`
      throw new LockfileError(`nothing ${mode} meets it${asked}${has}`, at(at(entry.where, 'require'), link.target))
    }
  }
}

// RuleSetGenerator::addConflictRules: a conflict with a name nothing has,
// or provides alone, makes no rule; nor does an alias met but by a provide
// or a replace, whose package conflicts anyway.
function checkConflicts(pool) {
  const owned = new Set(pool.entries.filter((entry) => entry.alias === undefined).flatMap((entry) => [...namesOf(entry, false)]))
  for (const entry of pool.entries) {
    for (const link of entry.links.conflict) {
      if (isPlatform(link.target) || !owned.has(link.target)) continue
      const other = whatProvides(pool, link).find((match) => match !== entry && (match.alias === undefined || match.name === link.target))
      if (other !== undefined) throw new LockfileError(`conflicts with ${describe(other)}, which ${other.root ? 'composer.json is' : 'the lockfile has'}`, at(at(entry.where, 'conflict'), link.target))
    }
  }
}

// Locker::getMissingRequirementInfo: what the root requires, but of the
// platform or at self.version, met by the packages installed with it, or
// the root itself.
function checkRoot(root, pool, field) {
  for (const link of root.links[field]) {
    if (isPlatform(link.target) || link.pretty === 'self.version' || whatProvides(pool, link).length > 0) continue
    throw new LockfileError(`nothing in the lockfile${field === 'requireDev' ? '' : ' that composer install --no-dev installs'} meets it, which composer install refuses`, at(at(root.where, LINKS[field]), link.target))
  }
}

// What meets each requirement, of the packages installed with the one that
// asks: by name, with no alias twice, and not the root.
function edgesOf(entry, pool) {
  const edges = Object.create(null)
  for (const link of entry.links.require) {
    const targets = [...new Set(whatProvides(pool, link).filter((match) => !match.root).map((match) => (match.base ?? match).name))]
    edges[link.target] = { constraint: link.pretty, platform: isPlatform(link.target), targets }
  }
  return edges
}

// `items` are the packages read, `{ pkg, links, where }`, the non-dev
// first; `aliases` the root's, each of a package among them;
// `stabilityFlags` by name; `root` what readComposerJson reads, or
// undefined.
export function resolve(items, aliases, minimumStability, stabilityFlags, root) {
  const bases = items.map(({ pkg, links, where }) => ({ name: lower(pkg.name), version: pkg.normalized, exact: exactly(pkg.normalized), stability: pkg.stability, links, pkg, where }))
  const rooted = root === undefined ? [] : [{ ...root, exact: root.version === undefined ? undefined : exactly(root.version), where: WHERE, root: true }]
  checkNames([...rooted, ...bases])
  const byName = new Map(bases.map((entry) => [entry.name, entry]))
  const entries = []
  const aliasesOf = new Map(bases.map((base) => [base, []]))
  const add = (alias) => {
    entries.push(alias)
    aliasesOf.get(alias.base).push(alias)
  }
  for (const base of bases) {
    entries.push(base)
    const version = branchAlias(base.pkg, base.where)
    if (version !== undefined) add(aliasOf(base, version, version.replaceAll(/(?:\.9{7})+/gu, '.x'), false))
  }
  for (const alias of aliases) add(aliasOf(byName.get(alias.package), alias.aliasNormalized, alias.alias, true))
  for (const entry of entries) {
    if (!acceptable(entry, minimumStability, stabilityFlags)) {
      const which = entry.alias === undefined ? '' : `its alias ${entry.pretty}, `
      throw new LockfileError(`${which}of stability ${entry.stability}, which minimum-stability, ${minimumStability}, and stability-flags do not take, and Composer installs nothing against`, entry.where)
    }
  }
  const isDev = (entry) => (entry.base ?? entry).pkg.dev
  const nonDev = entries.filter((entry) => !isDev(entry))
  const production = poolOf([...rooted, ...nonDev])
  const all = poolOf([...rooted, ...entries])
  checkConflicts(all)
  // Without composer.json, a requirement nothing meets the root may
  // provide, or replace, and is let be.
  if (root !== undefined) {
    checkRequires(nonDev, production, 'that composer install --no-dev installs', all)
    checkRequires(entries.filter(isDev), all, 'in the lockfile', all)
    checkRoot(rooted[0], production, 'require')
    checkRoot(rooted[0], all, 'requireDev')
  }
  return new Map(bases.map((base) => [base, {
    require: edgesOf(base, isDev(base) ? all : production),
    aliases: aliasesOf.get(base).map((entry) => ({ version: entry.pretty, normalized: entry.version, root: entry.alias === 'root' })),
  }]))
}
