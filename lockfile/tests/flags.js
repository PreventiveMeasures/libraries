// The flags of how each package is depended on, worked out as npm's
// calcDepFlags does, to hold the readers to: each package starts with all
// three, and loses one wherever an edge without it leads to it from a
// package without it, until none changes. The readers walk the graph once
// for each flag instead.

const NONE = { dev: false, optional: false, devOptional: false }
const KINDS = { dependencies: 'dependencies', devDependencies: 'devDependencies', optionalDependencies: 'optionalDependencies' }

// By package, from the importers' lists of `kinds`, each named as one of
// npm's: `dependencies`, `devDependencies` or `optionalDependencies`.
export function npmFlags({ importers, packages }, kinds = KINDS) {
  const flags = new Map(Object.values(packages).map((pkg) => [pkg, { dev: true, optional: true, devOptional: true }]))
  const queue = []
  const follow = (from, targets, kind) => {
    const [dev, optional] = [kind === 'devDependencies', kind === 'optionalDependencies']
    for (const target of Object.values(targets)) {
      if (target.startsWith('link:')) continue
      const pkg = packages[target]
      const to = flags.get(pkg)
      const keeps = { dev: from.dev || dev, optional: from.optional || optional, devOptional: from.devOptional || dev || optional }
      const lost = Object.keys(keeps).filter((flag) => to[flag] && !keeps[flag])
      for (const flag of lost) to[flag] = false
      if (lost.length > 0) queue.push(pkg)
    }
  }
  for (const importer of Object.values(importers)) for (const [list, kind] of Object.entries(kinds)) follow(NONE, importer[list], kind)
  while (queue.length > 0) {
    const pkg = queue.pop()
    for (const kind of ['dependencies', 'optionalDependencies']) follow(flags.get(pkg), pkg[kind], kind)
  }
  return flags
}

// The flags a package was read with.
export const flagsOf = ({ dev, optional, devOptional }) => ({ dev, optional, devOptional })
