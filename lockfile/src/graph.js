// The graph both readers hand back: packages by key, each with targets, by
// alias, of its dependencies and its optional ones; a `link:` is no key.

import { LockfileError, at } from './error.js'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// Dependencies and optional ones, each as `read` makes it, none in both.
export function readLists(holder, where, read) {
  const [dependencies, optionalDependencies] = ['dependencies', 'optionalDependencies'].map((kind) => read(holder[kind], at(where, kind)))
  const both = Object.keys(optionalDependencies).find((alias) => alias in dependencies)
  if (both !== undefined) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), both))
  return { dependencies, optionalDependencies }
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
