// pnpm's read-package hook (@pnpm/hooks.read-package-hook), less a pnpmfile's
// readPackage, refused elsewhere, and Yarn's compatibility database, not
// reproduced. pnpm runs it on every package and on each project's
// package.json before holding it to its importer.

import { intersects, satisfies, validRange } from '@preventive/upstream/semver.js'
import { relative } from '@preventive/vfs/path.js'
import { DeptreeError } from '../error.js'
import { checkNesting } from '../manifest.js'
import { createMatcher } from '../matcher.js'
import { extend, extensionsOf, inRange } from './extensions.js'

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

// The hook's `dir` is a project's directory, which directory overrides are
// written relative to; undefined for a package.
export function createHook({ overrides, extensions = [], ignored, major = 10 }) {
  const byName = (list) => Map.groupBy(list, ({ target }) => target.name)
  const withParent = overrides.filter(({ parent }) => parent !== undefined)
  const generic = byName(overrides.filter(({ parent, converge }) => parent === undefined && !converge))
  const converging = new Map(overrides.filter(({ converge }) => converge).map(({ target, spec }) => [target.name, spec]))
  const isIgnored = createMatcher(ignored)
  return (manifest, where, { dir } = {}) => {
    checkFields(manifest, where)
    const copy = structuredClone(checkNesting(manifest, where))
    extend(copy, extensionsOf(extensions, copy, where))
    if (overrides.length > 0) {
      const scoped = byName(withParent.filter(({ parent }) => parent.name === copy.name && (!parent.range || inRange(copy.version, parent.range, where, 'an override'))))
      const pick = (list, spec) => mostSpecific((list ?? []).filter(({ target }) => meets(target.range, spec)))
      const override = (deps, peers) => {
        const given = peers ?? deps
        for (const [name, spec] of Object.entries(given)) {
          const chosen = pick(scoped.get(name), spec) ?? pick(generic.get(name), spec)
          const version = converging.get(name)
          if (chosen === undefined) {
            if (version !== undefined && validRange(spec, { loose: true }) !== null && satisfies(version, spec, { loose: true })) given[name] = version
            continue
          }
          if (chosen.spec === '-') {
            delete given[name]
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
      if (copy.peerDependencies !== undefined) override(copy.dependencies ??= {}, copy.peerDependencies)
    }
    for (const name of Object.keys(copy.optionalDependencies ?? {})) {
      if (!isIgnored(name)) continue
      delete copy.optionalDependencies[name]
      delete copy.dependencies?.[name]
    }
    return copy
  }
}
