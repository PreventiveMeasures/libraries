// Where yarn 1 fails as it links bins (package-linker.js): of each package
// in the tree, each dependency's bins are linked from its copy nearest the
// package's node_modules, as node would find it from there, and yarn fails
// where there is none. What linking does to the tree, each target made
// executable, yarn's fetcher has done already (package.js). A dependency
// with no copy of its own reference in the tree, as one deduplicated into
// another's has none, links none, as yarn has no location for it.

import { dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// Whether node finds the package at `loc` by its name from `dir`, a
// directory at a time up from it, as yarn's
// findNearestInstalledVersionOfPackage looks. Paths are from the
// lockfile's directory, `.` it.
function finds(name, loc, dir) {
  for (;; dir = dirname(dir)) {
    if (join(dir, name) === loc || join(dir, `node_modules/${name}`) === loc) return true
    if (dir === '.') return false
  }
}

// `placed` the flat tree, tree.js's; `patterns` resolve.js's; `hasBins`
// whether each registry package has bins, as yarn reads them from its
// package.json and files; `locations` each reference's copies, where they
// really are, and `realOf` where a path in the tree really is.
export function checkBinLinks({ placed, patterns, hasBins, locations, realOf }) {
  for (const { loc, info } of placed) {
    const binLoc = `${loc}/node_modules`
    const realBinLoc = realOf(binLoc)
    for (const pattern of info.ref.dependencies) {
      const dep = patterns.get(pattern)
      if (dep.kind !== 'registry' || !locations.has(dep) || !hasBins.get(dep)) continue
      const found = locations.get(dep).some((at) => finds(dep.name, at, binLoc) || finds(dep.name, at, realBinLoc))
      if (!found) throw new DeptreeError(`yarn finds no copy of ${quote(dep.name)} to link the bins of`, quote(loc))
    }
  }
}
