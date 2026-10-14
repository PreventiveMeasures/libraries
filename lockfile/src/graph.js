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

// The flags npm writes of how each package is depended on, by the kinds
// of the importers' lists that are `required`, `dev` and `optional`: `dev`
// where no required or optional dependency of an importer reaches it,
// which an install of no devDependencies leaves out; `optional` where no
// required or dev one does but through an optional dependency, which an
// install of no optional ones leaves out; `devOptional` where no required
// one does but through either, which an install of neither leaves out. A
// `link:` is no package: an importer it leads to is reached as one. By
// package, so that the keys of one share its flags.
export function flagsOf(packages, importers, { required = ['dependencies'], dev = ['devDependencies'], optional = ['optionalDependencies'] } = {}) {
  const reach = (kinds, through) => {
    const reached = new Set()
    const visit = (targets) => {
      for (const key of Object.values(targets)) if (!key.startsWith('link:')) reached.add(packages[key])
    }
    for (const importer of Object.values(importers)) for (const kind of kinds) visit(importer[kind])
    for (const pkg of reached) for (const kind of through) visit(pkg[kind])
    return reached
  }
  const prod = reach([...required, ...optional], ['dependencies', 'optionalDependencies'])
  const plain = reach([...required, ...dev], ['dependencies'])
  const needed = reach(required, ['dependencies'])
  return (pkg) => ({ dev: !prod.has(pkg), optional: !plain.has(pkg), devOptional: !needed.has(pkg) })
}
