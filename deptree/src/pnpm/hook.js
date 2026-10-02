// pnpm's read-package hook (@pnpm/hooks.read-package-hook), less package
// extensions and a pnpmfile's readPackage, refused elsewhere, and Yarn's
// compatibility database, not reproduced. pnpm runs it on every package and on
// each project's package.json before holding it to its importer.

import { intersects, satisfies, validRange } from '@preventive/upstream/semver.js'
import { relative } from '@preventive/vfs/path.js'
import { DeptreeError } from '../error.js'
import { checkNesting } from '../manifest.js'
import { createMatcher } from '../matcher.js'

const KINDS = ['dependencies', 'optionalDependencies', 'devDependencies']

// pnpm's isIntersectingRange.
const meets = (range, spec) => !range || spec === range || (validRange(spec) !== null && validRange(range) !== null && intersects(spec, range))

// pickMostSpecificVersionOverride, with its own comparator and sort: the
// order it leaves overrides in is the one pnpm takes the first of.
const mostSpecific = (overrides) => overrides.sort((a, b) => (meets(b.target.range ?? '', a.target.range ?? '') ? -1 : 1))[0]

const isPeerRange = (spec) => validRange(spec) !== null || spec.includes('workspace:') || spec.includes('catalog:')

function localSpec({ protocol, dir: to }, dir) {
  const path = relative(dir, to) || '.'
  return protocol === '' && !path.startsWith('.') ? `./${path}` : `${protocol}${path}`
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

// semver's satisfies, which throws a TypeError on a version that is neither
// a string nor falsy, as pnpm then fails.
function inParentRange(version, range, where) {
  if (version && typeof version !== 'string') throw new DeptreeError('not a string, which pnpm fails on where an override names this package with a range', `${where}.version`)
  return satisfies(version, range)
}

// The hook's `dir` is a project's directory, which directory overrides are
// written relative to; undefined for a package.
export function createHook({ overrides, ignored, major = 10 }) {
  const byName = (list) => Map.groupBy(list, ({ target }) => target.name)
  const withParent = overrides.filter(({ parent }) => parent !== undefined)
  const generic = byName(overrides.filter(({ parent, converge }) => parent === undefined && !converge))
  const converging = new Map(overrides.filter(({ converge }) => converge).map(({ target, spec }) => [target.name, spec]))
  const isIgnored = createMatcher(ignored)
  return (manifest, where, { dir } = {}) => {
    checkFields(manifest, where)
    const copy = structuredClone(checkNesting(manifest, where))
    if (overrides.length > 0) {
      const scoped = byName(withParent.filter(({ parent }) => parent.name === copy.name && (!parent.range || inParentRange(copy.version, parent.range, where))))
      const pick = (list, spec) => mostSpecific((list ?? []).filter(({ target }) => meets(target.range, spec)))
      const override = (deps, peers) => {
        for (const [name, spec] of Object.entries(peers ?? deps)) {
          const chosen = pick(scoped.get(name), spec) ?? pick(generic.get(name), spec)
          const version = converging.get(name)
          if (chosen === undefined) {
            if (version !== undefined && validRange(spec, { loose: true }) !== null && satisfies(version, spec, { loose: true })) (peers ?? deps)[name] = version
            continue
          }
          if (chosen.spec === '-') {
            delete (peers ?? deps)[name]
            if (peers !== undefined && major >= 11) delete copy.peerDependenciesMeta?.[name]
            continue
          }
          const { local } = chosen
          const wanted = dir !== undefined && local !== undefined && (major >= 11 || local.protocol !== '') ? localSpec(local, dir) : chosen.spec
          if (peers === undefined || !isPeerRange(wanted)) deps[name] = wanted
          else peers[name] = wanted
        }
      }
      for (const kind of KINDS) if (copy[kind] !== undefined) override(copy[kind])
      if (copy.peerDependencies !== undefined) {
        // pnpm 9 overrides a peer in place whatever the override is.
        if (major < 10) override(copy.peerDependencies)
        else override(copy.dependencies ??= {}, copy.peerDependencies)
      }
    }
    for (const name of Object.keys(copy.optionalDependencies ?? {})) {
      if (!isIgnored(name)) continue
      delete copy.optionalDependencies[name]
      delete copy.dependencies?.[name]
    }
    return copy
  }
}
