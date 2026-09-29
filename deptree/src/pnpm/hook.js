// What pnpm 10 makes of a package.json before it reads its dependencies:
// its read-package hook (@pnpm/hooks.read-package-hook), less what is
// refused elsewhere — package extensions and a pnpmfile's readPackage —
// and less Yarn's compatibility database, which adds dependencies to a few
// packages by name and is not reproduced. Overrides replace or, as `-`,
// remove what the package asks for (createVersionsOverrider), and
// ignoredOptionalDependencies removes the optional dependencies it names.
// pnpm runs it on every package it resolves and on every project's
// package.json before holding it to its importer, which is why a project
// overridden is recorded as overridden.
//
// An override to a directory, `link:` or `file:`, is written into a
// project relative to it, as pnpm writes it; pnpm 11 takes a path alone
// for one too, where pnpm 10 writes it as it is. pnpm 11 also converges
// where no override is chosen (overrides.js), and drops a peer's
// peerDependenciesMeta with the peer.

import { intersects, satisfies, validRange } from '@preventive/upstream/semver.js'
import { join, normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'

const KINDS = ['dependencies', 'optionalDependencies', 'devDependencies']

// pnpm's isIntersectingRange: no range is any, one range is itself, and
// two ranges meet where some version is in both.
const meets = (range, spec) => !range || spec === range || (validRange(spec) !== null && validRange(range) !== null && intersects(spec, range))

// pickMostSpecificVersionOverride, with its own comparator and sort: the
// order it leaves overrides in is the one pnpm takes the first of.
const mostSpecific = (overrides) => overrides.sort((a, b) => (meets(b.target.range ?? '', a.target.range ?? '') ? -1 : 1))[0]

const isPeerRange = (spec) => validRange(spec) !== null || spec.includes('workspace:') || spec.includes('catalog:')
const isLocal = (spec) => spec.startsWith('file:') || spec.startsWith('link:')

// A path from one directory to another, both relative to the lockfile's
// in its normal form; undefined where `from` climbs out of it.
function pathBetween(from, to) {
  const a = from === '.' ? [] : from.split('/')
  const b = to === '.' ? [] : to.split('/')
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  if (a.slice(shared).includes('..')) return undefined
  return [...a.slice(shared).map(() => '..'), ...b.slice(shared)].join('/') || '.'
}

// An override to a path, `file:`, `link:` or bare, as pnpm writes it into
// the project at `dir`: relative to it, from the lockfile's directory. One
// from the root or the home directory it leaves as it is, which is not
// known here.
function localSpec(spec, dir, selector, where) {
  const protocol = ['file:', 'link:'].find((prefix) => spec.startsWith(prefix)) ?? (/^(?:[./]|~\/)/u.test(spec) ? '' : undefined)
  if (protocol === undefined) return spec
  const path = spec.slice(protocol.length).replace(/\/+$/u, '')
  const resolved = /^(?:\/|~[/\\])/u.test(path) ? undefined : pathBetween(dir, normalize(join('.', path)))
  if (resolved === undefined) throw new DeptreeError(`the override ${quote(selector)} is to a path pnpm writes into the project's specifier as one from outside it`, where)
  return protocol === '' && !/^(?:[./]|~\/)/u.test(resolved) ? `./${resolved}` : `${protocol}${resolved}`
}

function checkFields(manifest, where) {
  for (const kind of [...KINDS, 'peerDependencies']) {
    const deps = manifest[kind]
    if (deps === undefined) continue
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps) || Object.values(deps).some((spec) => typeof spec !== 'string')) {
      throw new DeptreeError('expected a mapping of names to specifiers', `${where}.${kind}`)
    }
  }
}

// `overrides` is listOverrides's; `ignored` the ignoredOptionalDependencies
// patterns; `major` pnpm's major version. The hook hands back a changed
// copy of a package.json; `dir` is the directory of a project's, where an
// override to a path is written into it as pnpm writes it, and undefined
// for a package's, whose specifiers are not read.
export function createHook({ overrides, ignored, major = 10 }) {
  const withParent = overrides.filter(({ parent }) => parent !== undefined)
  const generic = overrides.filter(({ parent, converge }) => parent === undefined && !converge)
  const converging = new Map(overrides.filter(({ converge }) => converge).map(({ target, spec }) => [target.name, spec]))
  const isIgnored = ignored.length > 0 ? createMatcher(ignored) : undefined
  return (manifest, where, { dir } = {}) => {
    checkFields(manifest, where)
    const copy = structuredClone(manifest)
    if (overrides.length > 0) {
      const scoped = withParent.filter(({ parent }) => parent.name === copy.name && (!parent.range || satisfies(copy.version, parent.range)))
      const override = (deps, peers) => {
        for (const [name, spec] of Object.entries(peers ?? deps)) {
          const chosen = mostSpecific(scoped.filter(({ target }) => target.name === name && meets(target.range, spec)))
            ?? mostSpecific(generic.filter(({ target }) => target.name === name && meets(target.range, spec)))
          const version = converging.get(name)
          if (chosen === undefined && version !== undefined && validRange(spec, { loose: true }) !== null && satisfies(version, spec, { loose: true })) (peers ?? deps)[name] = version
          if (chosen === undefined) continue
          if (chosen.spec === '-') {
            delete (peers ?? deps)[name]
            if (peers !== undefined && major >= 11) delete copy.peerDependenciesMeta?.[name]
            continue
          }
          let wanted = chosen.spec
          if (dir !== undefined && (major >= 11 || isLocal(wanted))) wanted = localSpec(wanted, dir, chosen.selector, where)
          if (peers === undefined || !isPeerRange(wanted)) deps[name] = wanted
          else peers[name] = wanted
        }
      }
      for (const kind of KINDS) if (copy[kind] !== undefined) override(copy[kind])
      if (copy.peerDependencies !== undefined) override(copy.dependencies ??= {}, copy.peerDependencies)
    }
    if (isIgnored !== undefined) {
      for (const name of Object.keys(copy.optionalDependencies ?? {})) {
        if (!isIgnored(name)) continue
        delete copy.optionalDependencies[name]
        delete copy.dependencies?.[name]
      }
    }
    return copy
  }
}
