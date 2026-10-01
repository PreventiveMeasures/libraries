// What yarn 1 does to a tree as it links bins (package-linker.js), but for
// the links themselves: each target it links made executable, chmod 755.
// Of each package in the tree, each dependency's bins are linked from its
// copy nearest the package's node_modules, found as yarn finds it; then
// the top-level ones, of each name the copy the root requires directly,
// or else the first. A dependency with no copy of its own reference in
// the tree, as one deduplicated into another's has none, links none, as
// yarn has no location for it. A target that is no file, or under a
// workspace, is left as it is: the tree holds no workspace's files.

import { DeptreeError, quote } from '../error.js'
import { binsOf } from './package.js'

// yarn's findNearestInstalledVersionOfPackage: of a package's locations,
// the one nearest `binLoc`, a directory at a time up from it, as node would
// find it from there; then each again from where `binLoc` really is; the
// first of the nearest. Paths are from the lockfile's directory, `''` it.
const join = (dir, name) => (dir === '' ? name : `${dir}/${name}`)
const parentOf = (dir) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')

function nearestLocation(ref, locations, binLocs) {
  let best
  for (const binLoc of binLocs) {
    for (const loc of locations) {
      let current = binLoc
      let distance = 0
      while (join(current, ref.name) !== loc && join(current, `node_modules/${ref.name}`) !== loc) {
        if (current === '') {
          distance = undefined
          break
        }
        current = parentOf(current)
        distance++
      }
      if (distance !== undefined && (best === undefined || distance < best[1])) best = [loc, distance]
    }
  }
  return best?.[0]
}

// `placed` the flat tree, tree.js's; `patterns` resolve.js's; `fetched`
// each registry package's files, and `manifestOf` its package.json, as
// yarn has them; `locations` each reference's copies, where they really
// are, and `realOf` where a path in the tree really is.
export function markBins(vfs, { placed, patterns, fetched, manifestOf, locations, realOf }) {
  const bins = new Map()
  const binsFor = (ref) => {
    if (!bins.has(ref)) bins.set(ref, ref.kind === 'registry' ? binsOf(manifestOf.get(ref), fetched.get(ref)) : new Map())
    return bins.get(ref)
  }
  const executable = new Set()
  const linkSelf = (ref, loc) => {
    const real = realOf(loc)
    for (const target of binsFor(ref).values()) {
      const path = `/${real}/${target}`
      // What is not a file, a directory chmod leaves as it is, or nothing.
      if (!target.endsWith('/') && vfs.isFile(path)) executable.add(path)
    }
  }
  for (const { loc, info } of placed) {
    const binLoc = `${loc}/node_modules`
    const binLocs = realOf(binLoc) === binLoc ? [binLoc] : [binLoc, realOf(binLoc)]
    for (const pattern of info.ref.dependencies) {
      const dep = patterns.get(pattern)
      if (!locations.has(dep) || binsFor(dep).size === 0) continue
      const nearest = nearestLocation(dep, locations.get(dep), binLocs)
      if (nearest === undefined) throw new DeptreeError(`yarn finds no copy of ${quote(dep.name)} to link the bins of`, quote(loc))
      linkSelf(dep, nearest)
    }
  }
  const topLevel = new Map()
  for (const { loc, info } of placed) {
    if (info.isDirectRequire || !topLevel.has(info.ref.name)) topLevel.set(info.ref.name, { loc, ref: info.ref })
  }
  for (const { loc, ref } of topLevel.values()) {
    if (locations.has(ref) && binsFor(ref).size > 0) linkSelf(ref, loc)
  }
  for (const path of executable) if (path.includes('/node_modules/')) vfs.chmod(path, 0o755)
}
