// What bin-links does to the packages' files, the .bin links aside. Bins
// come from the lockfile; in a node_modules, the first package to claim a
// name links it, by Intl.Collator('en') on paths, as npm sorts its nodes,
// even where its target is missing. A linked target is made 0o755, its
// first line's CRLF made LF where that is a shebang in the first 2048 bytes.

import { basename, dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { fixShebang, isModules } from '../tarball.js'

const collator = new Intl.Collator('en')

// npm-normalize-package-bin.
function binsOf(bin) {
  const bins = new Map()
  for (const [key, target] of Object.entries(bin)) {
    const name = join('/', basename(key.replace(/[\\:]/gu, '/'))).slice(1)
    const path = join('/', target.replace(/\\/gu, '/')).slice(1)
    if (name !== '' && path !== '') bins.set(name, path.replace(/\/$/u, ''))
  }
  return bins
}

function modulesOf(location) {
  const parent = dirname(location)
  return basename(parent) === 'node_modules' ? parent : dirname(parent)
}

// The paths of the bins each package links, by its location, of the lockfile
// alone: those it claims a name for in its node_modules' .bin first.
export function claimedBins(nodes) {
  const seen = new Set()
  const claimed = new Map()
  for (const { location, pkg } of nodes.toSorted((a, b) => collator.compare(a.location, b.location))) {
    for (const [name, path] of binsOf(pkg.bin)) {
      const link = `${modulesOf(location)}/.bin/${name}`
      if (seen.has(link)) continue
      seen.add(link)
      claimed.set(location, [...claimed.get(location) ?? [], path])
    }
  }
  return claimed
}

// What linking `paths`, as claimedBins gives them, changes of the files of
// the package at `location`.
export function fixClaimed(location, paths, { files, dirs }) {
  const where = `packages[${quote(location)}].bin`
  const changed = new Map()
  for (const path of paths) {
    const segments = path.split('/')
    if (isModules(segments[0])) throw new DeptreeError(`${quote(path)} is in the package's own node_modules, where npm installs its dependencies, which is not supported`, where)
    if (segments.slice(1).some((_, i) => files.has(segments.slice(0, i + 1).join('/')))) throw new DeptreeError(`${quote(path)} runs through a file, which npm fails on`, where)
    const file = files.get(path)
    if (file === undefined) {
      if (!dirs.has(path)) continue
      throw new DeptreeError(`${quote(path)} is a directory, which is not supported`, where)
    }
    changed.set(path, { data: fixShebang(file.data, 'a bin with a CRLF shebang that is not UTF-8, which npm rewrites with replacement characters, is not supported', where), mode: 0o755 })
  }
  return changed
}

// The files linking changes, by each package's location.
export function fixBins(nodes, fetched) {
  const byLocation = new Map(nodes.map((node) => [node.location, node]))
  const changed = new Map()
  for (const [location, paths] of claimedBins(nodes)) {
    const fixed = fixClaimed(location, paths, fetched.get(byLocation.get(location)))
    if (fixed.size > 0) changed.set(location, fixed)
  }
  return changed
}
