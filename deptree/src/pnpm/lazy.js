// A lazy tree's unpack (../lazy.js), for pnpm: each package written as the
// full tree writes it once asked for, and only then fetched.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently, limited } from '../concurrent.js'
import { quote, refusalOf } from '../error.js'
import { unpacker, writeInto } from '../lazy.js'
import { NO_ABOUT } from '../tarball.js'
import { failsAsDirectory, fixChanges } from './bins.js'
import { binsOf } from './commands.js'
import { checkFetched, fetchPackage } from './package.js'
import { compose, writeNode } from './write.js'

// Whether what is done to a package's files turns on other packages', once
// fetched: with the hoisted linker where any patch is configured, pnpm's
// build pass builds it (`builds`), patched or with an install script, which
// turns on its other copies and what else is built; or which of its bins pnpm
// links could change them, one linked being fixed otherwise than it is, made
// executable or its CRLF `#!` line made LF; or pnpm 9 and 12 fail on one that
// is a directory; or the package is patched, which is held to its bins as
// linked; or its commands cannot be read alone. Else its files are as fetched
// and patched, whatever pnpm links of its bins, and of anything else's.
function bound(node, major, builds) {
  if (builds?.(node)) return true
  let bins
  try {
    bins = binsOf(node, node.manifest, node.files, major)
  } catch {
    return true
  }
  if (bins.size === 0) return false
  if (node.pkg.patchHash !== undefined) return true
  for (const path of bins.keys()) {
    if (failsAsDirectory(node, path, major)) return true
    const file = node.files.get(path)
    if (file?.data === undefined) continue
    if (fixChanges(file, major)) return true
  }
  return false
}

// What an unpacked package's files were, read back from the tree, which holds
// one neither patched nor bound as it came: but what the directories of the
// others among `dirs` hold within its own.
function filesIn(vfs, dir, dirs) {
  const files = new Map()
  for (const { path, type } of vfs.walk(`/${dir}`)) {
    if (type !== 'file') continue
    const rel = path.slice(dir.length + 2)
    const names = rel.split('/')
    let nested = false
    for (let i = 1; i < names.length && !nested; i++) nested = dirs.has(`${dir}/${names.slice(0, i).join('/')}`)
    if (!nested) files.set(rel, { data: vfs.readFile(path), mode: vfs.lstat(path).mode })
  }
  return files
}

// Each registry package fetched once for all its snapshots, a few at a time,
// and held to what the full tree holds it to; each snapshot written as the
// full tree writes it, `patched` and `composing` being what compose takes, and
// listed by `entryOf`. What linking bins fixes of it turns on the other
// packages' bins only where a package is bound (above): the first such
// unpack fetches those of `reads()` not unpacked yet, every package where it
// is not given, and reads the fixes by `fixes`, as the full tree does, one
// unpacked before read back from the tree, where it is as it came, and one
// not at hand read as having no bins, as the lockfile says. One read so that
// is bound once unpacked has the fixes read again, with its own files. A
// package's files are let go once it is unpacked, and its tarball once each
// of its snapshots is, but a patched one's, and every one's once the fixes
// are read. `early.nodes` are fetched before anything is unpacked, and held
// to `early.check()`.
export async function lazyUnpacker({ vfs, byDir, stats, fixes, reads, builds, early, checks, patched, composing, entryOf, fetching, folded }) {
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
    if (node.unpacked) {
      node.files = filesIn(vfs, node.dir, byDir)
      return
    }
    const got = await fetchOnce(node)
    checkFetched(node, got, checks)
    Object.assign(node, { files: got.files, manifest: got.manifest, about: got.about ?? NO_ABOUT })
  }
  // The fixes, with the packages not at hand read as having no bins.
  const readFixes = () => {
    const stubs = [...byDir.values()].filter((node) => node.files === undefined)
    const manifests = stubs.map((node) => node.manifest)
    for (const node of stubs) Object.assign(node, { files: new Map(), manifest: {} })
    try {
      return { ...fixes(), stubbed: new Set(stubs.map((node) => node.dir)) }
    } finally {
      for (const [i, node] of stubs.entries()) Object.assign(node, { files: undefined, manifest: manifests[i] })
    }
  }
  const fixesFor = async (node) => {
    made ??= (async () => {
      const read = reads?.()
      await eachConcurrently([...byDir.values()].filter((other) => read?.has(other.dir) ?? true), prepare, (other) => quote(other.key))
      return readFixes()
    })()
    if ((await made).stubbed.has(node.dir)) made = Promise.try(readFixes)
    return made
  }
  const release = (node) => {
    const id = packageKeyOf(node.key)
    left.set(id, left.get(id) - 1)
    if (left.get(id) === 0) fetched.delete(id)
    if (made === undefined && node.pkg.resolution.type !== 'directory' && node.pkg.patchHash === undefined) Object.assign(node, { files: undefined, unpacked: true })
  }

  if (early !== undefined) {
    await eachConcurrently(early.nodes, prepare, (node) => quote(node.key))
    early.check()
  }
  return unpacker(byDir, async (node) => {
    await prepare(node)
    const { targets, executable } = bound(node, major, builds) ? await fixesFor(node) : { targets: new Map(), executable: new Map() }
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
