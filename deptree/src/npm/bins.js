// What linking bins does to the packages, as bin-links does it after npm
// unpacks them, the .bin links themselves aside. Each installed package's
// bins, as the lockfile has them and npm-normalize-package-bin reads them,
// are linked into the .bin of the node_modules it is in; of two packages
// there with a bin of one name, only the first links it, in the order of
// their paths as Intl.Collator('en') sorts them, as npm sorts its nodes.
// The bin's target, where it links one, is made 0o755, and, where the
// first line of its first 2048 bytes is a shebang that ends in CRLF, that
// line's CR is dropped. A target that is missing is passed over, but takes
// the name all the same. A workspace's bins, linked after every package's,
// are its own files, which the tree does not hold.

import { basename, dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

const collator = new Intl.Collator('en')

// npm-normalize-package-bin: each name its last segment, a `\` or `:` as a
// `/`; each target a path within the package. Either empty is dropped.
function binsOf(bin) {
  const bins = new Map()
  for (const [key, target] of Object.entries(bin)) {
    const name = join('/', basename(key.replace(/[\\:]/gu, '/'))).slice(1)
    const path = join('/', target.replace(/\\/gu, '/')).slice(1)
    if (name !== '' && path !== '') bins.set(name, path.replace(/\/$/u, ''))
  }
  return bins
}

// The node_modules whose .bin a package's bins are linked into.
function modulesOf(location) {
  const parent = dirname(location)
  return basename(parent) === 'node_modules' ? parent : dirname(parent)
}

const decoder = new TextDecoder('utf-8', { fatal: true })

// fixBin on a file: the CR of a first line that ends in CRLF dropped, as
// bin-links rewrites the file as UTF-8, which it has to be here.
function fixed({ data }, where) {
  const newline = data.subarray(0, 2048).indexOf(0x0a)
  if (data[0] !== 0x23 || data[1] !== 0x21 || newline < 4 || data[newline - 1] !== 0x0d) return { data, mode: 0o755 }
  try {
    decoder.decode(data)
  } catch {
    throw new DeptreeError('a bin with a CRLF shebang that is not UTF-8, which npm rewrites with replacement characters, is not supported', where)
  }
  const unix = new Uint8Array(data.length - 1)
  unix.set(data.subarray(0, newline - 1))
  unix.set(data.subarray(newline), newline - 1)
  return { data: unix, mode: 0o755 }
}

// `installed` maps each package's location to its lockfile entry and its
// files; the files each copy has otherwise, by location and path, back.
export function fixBins(installed) {
  const order = [...installed.keys()].filter((location) => Object.keys(installed.get(location).pkg.bin).length > 0)
  order.sort((a, b) => collator.compare(a, b))
  const seen = new Set()
  const changed = new Map()
  for (const location of order) {
    const { pkg, files, dirs } = installed.get(location)
    const where = `packages[${quote(location)}].bin`
    for (const [name, path] of binsOf(pkg.bin)) {
      const link = `${modulesOf(location)}/.bin/${name}`
      if (seen.has(link)) continue
      seen.add(link)
      const segments = path.split('/')
      if (segments[0] === 'node_modules') throw new DeptreeError(`${quote(path)} is in the package's own node_modules, where npm installs its dependencies, which is not supported`, where)
      if (segments.slice(1).some((_, i) => files.has(segments.slice(0, i + 1).join('/')))) throw new DeptreeError(`${quote(path)} runs through a file, which npm fails on`, where)
      const file = files.get(path)
      if (file === undefined) {
        if (!dirs.has(path)) continue
        throw new DeptreeError(`${quote(path)} is a directory, which is not supported`, where)
      }
      if (!changed.has(location)) changed.set(location, new Map())
      changed.get(location).set(path, fixed(file, where))
    }
  }
  return changed
}
