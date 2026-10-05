// Where yarn 1 fails as it links bins (package-linker.js). The one change
// linking makes to the tree, each target made executable, package.js has
// made. A dependency deduplicated into another's reference links no bins.

import { dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// As yarn's findNearestInstalledVersionOfPackage looks; paths are from the
// lockfile's directory, `.`.
function finds(name, loc, dir) {
  for (;; dir = dirname(dir)) {
    if (join(dir, name) === loc || join(dir, `node_modules/${name}`) === loc) return true
    if (dir === '.') return false
  }
}

export function checkBinLinks({ placed, patterns, locations, realOf }) {
  for (const { loc, info } of placed) {
    const binLoc = `${loc}/node_modules`
    const realBinLoc = realOf(binLoc)
    for (const pattern of info.ref.dependencies) {
      const dep = patterns.get(pattern)
      if (dep.kind === 'workspace' || !locations.has(dep) || !dep.hasBins) continue
      const found = locations.get(dep).some((at) => finds(dep.name, at, binLoc) || finds(dep.name, at, realBinLoc))
      if (!found) throw new DeptreeError(`yarn finds no copy of ${quote(dep.name)} to link the bins of`, quote(loc))
    }
  }
}
