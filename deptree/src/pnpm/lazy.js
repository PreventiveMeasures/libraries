// A lazy tree's unpack (../lazy.js), for pnpm: each package written as the
// full tree writes it once asked for, and only then fetched.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently, limited } from '../concurrent.js'
import { quote, refusalOf } from '../error.js'
import { unpacker, writeInto } from '../lazy.js'
import { NO_ABOUT, crlfShebang } from '../tarball.js'
import { executableMode } from './bins.js'
import { binsOf } from './commands.js'
import { checkFetched, fetchPackage } from './package.js'
import { compose, writeNode } from './write.js'

// Whether which of its bins pnpm links could change a package's files, once
// fetched: one linked would be fixed otherwise than it is, made executable or
// its CRLF `#!` line made LF; or pnpm 9 and 12 fail on one that is a
// directory; or the package is patched, which is held to its bins as linked;
// or its commands cannot be read alone. Else its files are as fetched and
// patched, whatever pnpm links of its bins, and of anything else's.
export function bound(node, major) {
  let bins
  try {
    bins = binsOf(node, node.manifest, node.files, major)
  } catch {
    return true
  }
  if (bins.size === 0) return false
  if (node.pkg.patchHash !== undefined) return true
  for (const path of bins.keys()) {
    if ((major < 10 || major >= 12) && (path === '' || node.files.keys().some((name) => name.startsWith(`${path}/`)))) return true
    const file = node.files.get(path)
    if (file?.data === undefined) continue
    if (executableMode(file.mode, major) !== file.mode || (major < 12 && crlfShebang(file.data) !== -1)) return true
  }
  return false
}

// Each registry package fetched once for all its snapshots, a few at a time,
// and held to what the full tree holds it to; each snapshot written as the
// full tree writes it, `patched` and `composing` being what compose takes, and
// listed by `entryOf`. What linking bins fixes of it turns on the other
// packages' bins only where a package is bound (above): the first such
// unpack fetches every package and reads them by `fixes`, as the full tree
// does. A package's files are let go once each of its snapshots is unpacked,
// unless the fixes have been read, which keeps them all.
export function lazyUnpacker({ vfs, byDir, stats, fixes, checks, patched, composing, entryOf, fetching, folded }) {
  const { major } = composing
  const limit = limited()
  const fetched = new Map()
  const counted = new Set()
  const left = new Map()
  for (const node of byDir.values()) left.set(packageKeyOf(node.key), (left.get(packageKeyOf(node.key)) ?? 0) + 1)
  let made

  const fetchOnce = (node) => {
    const id = packageKeyOf(node.key)
    if (!fetched.has(id)) {
      fetched.set(id, limit(() => fetchPackage(node.pkg, quote(id), major, fetching)).then((got) => {
        counted.add(id)
        stats.tarballs = counted.size
        return got
      }, (error) => {
        throw refusalOf(error, quote(id))
      }))
    }
    return fetched.get(id)
  }
  // A directory's files are read with the tree.
  const prepare = async (node) => {
    if (node.files !== undefined) return
    const got = await fetchOnce(node)
    checkFetched(node, got, checks)
    Object.assign(node, { files: got.files, manifest: got.manifest, about: got.about ?? NO_ABOUT })
  }
  const allFixes = () => {
    made ??= (async () => {
      await eachConcurrently(byDir.values(), prepare, (node) => quote(node.key))
      return fixes()
    })()
    return made
  }
  const release = (node) => {
    const id = packageKeyOf(node.key)
    left.set(id, left.get(id) - 1)
    if (left.get(id) === 0) fetched.delete(id)
    if (made === undefined && node.pkg.resolution.type !== 'directory') Object.assign(node, { files: undefined, manifest: undefined })
  }

  return unpacker(new Map([...byDir.values()].map((node) => [node.dir, node])), async (node) => {
    await prepare(node)
    const { targets, executable } = bound(node, major) ? await allFixes() : { targets: new Map(), executable: new Map() }
    const tree = new Vfs()
    const written = { files: 0, bytes: 0 }
    try {
      writeNode(tree, node.dir, compose(node, patched, { targets: targets.get(node.dir) ?? new Set(), executable: executable.get(node.dir) ?? new Set() }, composing), written)
      writeInto(vfs, tree, folded)
    } catch (error) {
      throw refusalOf(error, quote(node.key))
    }
    stats.files += written.files
    stats.bytes += written.bytes
    release(node)
    return entryOf(node)
  })
}
