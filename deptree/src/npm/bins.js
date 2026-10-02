// What bin-links does to the packages' files, the .bin links aside. Bins
// come from the lockfile; in a node_modules, the first package to claim a
// name links it, by Intl.Collator('en') on paths, as npm sorts its nodes,
// even where its target is missing. A linked target is made 0o755, its
// first line's CRLF made LF where that is a shebang in the first 2048 bytes.

import { basename, dirname, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

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

const decoder = new TextDecoder('utf-8', { fatal: true })

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

// The files linking changes, by each package's location.
export function fixBins(nodes, fetched) {
  const seen = new Set()
  const changed = new Map()
  for (const node of nodes.toSorted((a, b) => collator.compare(a.location, b.location))) {
    const { location, pkg } = node
    const { files, dirs } = fetched.get(node)
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
