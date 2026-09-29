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

import { intersects, satisfies, validRange } from '@preventive/upstream/semver.js'
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
// patterns. The hook hands back a changed copy of a package.json; `local`
// says what to do with an override to a `link:` or `file:` path, which pnpm
// makes absolute where it has no directory to make it relative to.
export function createHook({ overrides, ignored }) {
  const withParent = overrides.filter(({ parent }) => parent !== undefined)
  const generic = overrides.filter(({ parent }) => parent === undefined)
  const isIgnored = ignored.length > 0 ? createMatcher(ignored) : undefined
  return (manifest, where, { local = 'keep' } = {}) => {
    checkFields(manifest, where)
    const copy = structuredClone(manifest)
    if (overrides.length > 0) {
      const scoped = withParent.filter(({ parent }) => parent.name === copy.name && (!parent.range || satisfies(copy.version, parent.range)))
      const override = (deps, peers) => {
        for (const [name, spec] of Object.entries(peers ?? deps)) {
          const chosen = mostSpecific(scoped.filter(({ target }) => target.name === name && meets(target.range, spec)))
            ?? mostSpecific(generic.filter(({ target }) => target.name === name && meets(target.range, spec)))
          if (chosen === undefined) continue
          if (chosen.spec === '-') {
            delete (peers ?? deps)[name]
            continue
          }
          if (isLocal(chosen.spec) && local === 'refuse') throw new DeptreeError(`the override ${quote(chosen.selector)} is to a local path, which pnpm writes into a project's specifier as an absolute one`, where)
          if (peers === undefined || !isPeerRange(chosen.spec)) deps[name] = chosen.spec
          else peers[name] = chosen.spec
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
