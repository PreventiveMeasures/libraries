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

// The keys the targets in `starts` lead to, through the packages.
export function reach(starts, packages) {
  const reached = new Set()
  const queue = []
  const visit = (targets) => {
    for (const key of Object.values(targets)) {
      if (key.startsWith('link:') || reached.has(key)) continue
      reached.add(key)
      queue.push(key)
    }
  }
  for (const targets of starts) visit(targets)
  while (queue.length > 0) {
    const pkg = packages[queue.pop()]
    visit(pkg.dependencies)
    visit(pkg.optionalDependencies)
  }
  return reached
}
