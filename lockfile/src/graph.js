// The graph both readers hand back: packages by key, each with targets, by
// alias, of its dependencies and its optional ones; a `link:` is no key.

import { LockfileError, at } from './error.js'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// A name in both lists, which npm installs as optional, is refused.
export function checkOptional(dependencies, optionalDependencies, where) {
  for (const alias of Object.keys(optionalDependencies)) {
    if (alias in dependencies) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), alias))
  }
}

// The first of the packages the targets in `starts` lead to none of,
// through the packages.
export function unreached(starts, packages) {
  const reached = new Set()
  const visit = (targets) => {
    for (const key of Object.values(targets)) if (!key.startsWith('link:')) reached.add(key)
  }
  for (const targets of starts) visit(targets)
  for (const key of reached) {
    visit(packages[key].dependencies)
    visit(packages[key].optionalDependencies)
  }
  return Object.keys(packages).find((key) => !reached.has(key))
}
