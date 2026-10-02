// Where yarn 1 fails as it links bins (package-linker.js): each package
// links each dependency's bins from the copy node would find from its
// node_modules, and yarn fails where there is none. The one change linking
// makes to the tree, each target made executable, package.js has made. A
// dependency deduplicated into another's reference has no location of its
// own, and links none.

import { dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// Whether node finds `name` at `loc` from `dir`, as yarn's
// findNearestInstalledVersionOfPackage looks. Paths are from the lockfile's
// directory, which is `.`.
function finds(name, loc, dir) {
  for (;; dir = dirname(dir)) {
    if (join(dir, name) === loc || join(dir, `node_modules/${name}`) === loc) return true
    if (dir === '.') return false
  }
}

// `placed` is tree.js's flat tree, `patterns` resolve.js's, `locations`
// each reference's copies by where they really are, and `realOf` where a
// path in the tree really is.
export function checkBinLinks({ placed, patterns, locations, realOf }) {
  for (const { loc, info } of placed) {
    const binLoc = `${loc}/node_modules`
    const realBinLoc = realOf(binLoc)
    for (const pattern of info.ref.dependencies) {
      const dep = patterns.get(pattern)
      if (dep.kind !== 'registry' || !locations.has(dep) || !dep.hasBins) continue
      const found = locations.get(dep).some((at) => finds(dep.name, at, binLoc) || finds(dep.name, at, realBinLoc))
      if (!found) throw new DeptreeError(`yarn finds no copy of ${quote(dep.name)} to link the bins of`, quote(loc))
    }
  }
}
