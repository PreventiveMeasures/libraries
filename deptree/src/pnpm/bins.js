// Which files pnpm's bin linking fixes (@pnpm/link-bins, and bin-links'
// fixBin): no .bin is written here, but each file a linked bin runs is
// made executable, and a CRLF ending its `#!` line made LF. pnpm 10 sets
// mode 0o755 and pnpm 11 adds the 0o111 a mode lacks, the same for the
// 0o644 and 0o755 files have here.
//
// pnpm runs fixBin only on the file of the command it links by a name, in
// each package's .bin (for its children's and bundled packages' bins),
// the private hoist's, and each project's (for its direct dependencies',
// at the root all that is publicly hoisted, and, with pnpm 11 and
// autoInstallPeers, its dependencies' peers). Where any patch is
// configured, each package patched or with an install script is built,
// which links its own bins beside its children's before the patch.
//
// A fix that would turn on the order a directory is read in, which
// varies, or on bins not known here, is refused (fixedFiles), as is a
// patch that would change one between two links (checkPatchOfBins).
//
// pnpm 12 (its cmd-shim crate) only adds the 0o111 a file lacks and
// rewrites no `#!` line. It links a package's own bins into its own .bin,
// beside its children's the lockfile says have some and its bundled
// packages', in one go with no build pass; `link:` children take no part.
//
// pnpm 11 and 12 link a `node` command without fixing its file, but
// pnpm 12 fixes a direct dependency's `node` already linked when it links
// a project's bins again, as it does after patching any package, publicly
// hoisting any with bins, or installing peers with some.
// already.

import { DeptreeError, quote } from '../error.js'
import { UNKNOWN, binsOf, bundledCommands, commandsOf, compare, normalized, parseManifest } from './commands.js'

const decoder = new TextDecoder('utf-8', { fatal: true })

// The peers whose bins pnpm 11 links into a project's .bin: each one a
// direct dependency has that is not optional and that its snapshot
// resolves, in the order of the paths of their links beside it.
function peersOf(children, nodes) {
  const byPath = new Map()
  for (const dir of children.values()) {
    const node = nodes.get(dir)
    if (node === undefined) continue
    const { peerDependencies, peerDependenciesMeta, dependencies, optionalDependencies } = node.pkg
    for (const name of Object.keys(peerDependencies)) {
      if (peerDependenciesMeta[name]?.optional || (dependencies[name] === undefined && optionalDependencies[name] === undefined)) continue
      const peer = name === node.name ? node.dir : node.children.get(name)
      if (peer !== undefined) byPath.set(`${node.modules}/${name}`, peer)
    }
  }
  return [...byPath.keys()].sort().map((path) => byPath.get(path))
}

// pnpm's pkgRequiresBuild; pnpm 11 and 12 pass over a binding.gyp where
// package.json's gypfile is false.
export const requiresBuild = (manifest, files, major) => Boolean((manifest.scripts != null && (manifest.scripts.preinstall || manifest.scripts.install || manifest.scripts.postinstall))
  || (files.has('binding.gyp') && !(major >= 11 && manifest.gypfile === false)) || files.keys().some((path) => /^\.hooks[\\/]/u.test(path)))

// `fixed` holds each fixed file's package by the file's path in the tree,
// `contested` the package and why of each that may be fixed or not.
// `link` links commands into one .bin, `ordered` if pnpm always comes to
// them in this order, `fixNode` if pnpm 12 fixes a direct dependency's
// `node`; it returns the names linked and whether unknown ones may be.
function linker(major) {
  const fixed = new Map()
  const contested = new Map()
  const link = (commands, { ordered, where, fixNode = false }) => {
    const unknown = commands.some((command) => command.unknown)
    const best = new Map()
    for (const command of commands) {
      if (command.unknown) continue
      const tied = best.get(command.name)
      const order = tied === undefined ? 1 : compare(command, tied[0], where, major)
      if (order > 0) best.set(command.name, [command])
      else if (order === 0) tied.push(command)
    }
    for (const tied of best.values()) {
      // pnpm 11 and 12 link `node` with no fix of its file.
      if (major >= 11 && tied[0].name === 'node' && !(fixNode && tied.every((command) => command.direct !== false))) continue
      const unordered = new Set(tied.map(({ target }) => target)).size > 1 && (!ordered || tied.some((command) => command.unordered))
      for (const { target, owner } of unknown || unordered ? tied : tied.slice(0, 1)) {
        if (owner === undefined) continue
        if (unknown) contested.set(target, { owner, why: 'the bins of a directory outside the tree, which are not known here' })
        else if (unordered) contested.set(target, { owner, why: 'the order it reads a directory in, which varies' })
        else fixed.set(target, owner)
      }
    }
    return { names: new Set(best.keys()), unknown }
  }
  return { fixed, contested, link }
}

// The files pnpm runs fixBin on, as sets of paths by package directory.
// `nodes` is the graph by directory, each node with its package's `files`
// and `manifest`; `projects` each project's package.json by directory;
// `building` whether any patch is configured; `peers` autoInstallPeers.
export function binTargets({ nodes, projects, direct, links, publicHoist, building, peers, major }) {
  const commandCache = new Map()
  const commandsOfDir = (dir, { normalize = false } = {}) => {
    const node = nodes.get(dir)
    if (node !== undefined) {
      if (!commandCache.has(dir)) commandCache.set(dir, commandsOf(dir, node.manifest, node.files, dir, quote(node.key), major))
      return commandCache.get(dir)
    }
    // A project or `link:` target, outside the tree: its bins may take a
    // name, and any name where its package.json is not given (local.js).
    const manifest = projects.get(dir)
    if (manifest === undefined) return [UNKNOWN]
    const where = `manifests[${quote(dir)}]`
    return commandsOf(dir, normalize ? normalized(manifest, where) : manifest, undefined, undefined, where, major)
  }
  // The lockfile has no hasBin for a directory, whose bins pnpm 12 reads.
  const mayHaveBin = (dir) => nodes.get(dir)?.pkg.hasBin === true || nodes.get(dir)?.pkg.resolution.type === 'directory'

  const { fixed, contested, link } = linker(major)

  for (const node of nodes.values()) {
    const where = quote(node.key)
    const children = [...node.children.values()]
    if (major >= 12) {
      // The order its children come in is a map's, which varies.
      const commands = children.filter(mayHaveBin).flatMap((dir) => commandsOfDir(dir))
      if (node.pkg.bundledDependencies !== undefined) commands.push(...bundledCommands(node, where, major))
      if (mayHaveBin(node.dir)) commands.push(...commandsOfDir(node.dir))
      link(commands, { ordered: false, where })
      continue
    }
    const withBins = children.filter((dir) => nodes.get(dir)?.pkg.hasBin).flatMap((dir) => commandsOfDir(dir))
    if (children.every((dir) => nodes.has(dir))) link(withBins, { ordered: true, where })
    else link(children.flatMap((dir) => commandsOfDir(dir, { normalize: true })), { ordered: false, where })
    if (node.pkg.bundledDependencies !== undefined) link(bundledCommands(node, where, major), { ordered: false, where })
    if (building && (node.pkg.patchHash !== undefined || requiresBuild(node.manifest, node.files, major))) {
      link([...withBins, ...commandsOfDir(node.dir)], { ordered: true, where })
    }
  }

  const PRIVATE = 'node_modules/.pnpm/node_modules/'
  const hoisted = [...links].filter(([path, dir]) => path.startsWith(PRIVATE) && nodes.get(dir)?.pkg.hasBin)
  link(hoisted.flatMap(([, dir]) => commandsOfDir(dir)), { ordered: true, where: quote(PRIVATE.slice(0, -1)) })

  const patched = [...nodes.values()].some((node) => node.pkg.patchHash !== undefined)
  for (const [id, children] of direct) {
    const where = `importers[${quote(id)}]`
    const peerDirs = major >= 11 && peers ? peersOf(children, nodes) : []
    let relink = major >= 12 && (patched || peerDirs.some(mayHaveBin))
    let linked
    if (id === '.' && publicHoist) {
      const manifest = projects.get('.')
      const own = new Set(Object.keys({ ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }))
      const isOwn = (path) => own.has(path.slice('node_modules/'.length))
      // pnpm 12 links what it hoists of the projects apart, before.
      const entries = [...links].filter(([path, dir]) => /^node_modules\/(?:@[^/]+\/)?[^/@.][^/]*$/u.test(path)
        && (major < 12 || isOwn(path) || mayHaveBin(dir)))
      const commands = entries.flatMap(([path, dir]) => commandsOfDir(dir).map((command) => ({ ...command, direct: isOwn(path) })))
      const names = new Set(commands.filter((command) => command.direct).map(({ name }) => name))
      relink ||= major >= 12 && entries.some(([path, dir]) => !isOwn(path) && mayHaveBin(dir))
      linked = link([...commands.filter((command) => command.direct), ...commands.filter((command) => !names.has(command.name))], { ordered: false, where, fixNode: relink })
    } else {
      // pnpm 11 reads the bins only of what the lockfile says has some.
      const dirs = [...children.values()].filter((dir) => major < 11 || !nodes.has(dir) || (major >= 12 ? mayHaveBin(dir) : nodes.get(dir).pkg.hasBin))
      // pnpm 12 comes to them in the order of a map, which varies.
      linked = link(dirs.flatMap((dir) => commandsOfDir(dir)), { ordered: major < 12, where, fixNode: relink })
    }
    if (major >= 11 && peers) {
      // Where the names linked are not all known, neither are those left.
      const commands = peerDirs.flatMap((dir) => commandsOfDir(dir))
      link([...commands.filter(({ name }) => !linked.names.has(name)), ...linked.unknown ? [UNKNOWN] : []], { ordered: true, where })
    }
  }

  return fixedFiles(nodes, fixed, contested, major)
}

// A `contested` file is refused unless it is fixed anyway, is not there,
// or is one fixBin leaves as it is (`harmless`).
function fixedFiles(nodes, fixed, contested, major) {
  // pnpm 12 reads the `#!` line of a file it links, and fails on one
  // that is a directory: `path`, in the package, '' for the package itself.
  const checkDirectory = (node, path) => {
    if (major < 12) return
    const prefix = `${path}/`
    if (path === '' || node.files.keys().some((name) => name.startsWith(prefix))) {
      throw new DeptreeError(`its bin ${quote(path === '' ? '.' : path)} is a directory, which pnpm 12 fails on`, quote(node.key))
    }
  }
  for (const [target, { owner, why }] of contested) {
    const node = nodes.get(owner)
    const path = target.slice(owner.length + 1)
    checkDirectory(node, path)
    const file = node.files.get(path)
    const harmless = major >= 12 ? (file?.mode & 0o111) === 0o111 : file?.mode === 0o755 && !hasCrlfShebang(file.data) && node.pkg.patchHash === undefined
    if (fixed.has(target) || file?.data === undefined || harmless) continue
    throw new DeptreeError(`whether pnpm makes ${quote(path)} executable turns on ${why}`, quote(node.key))
  }
  const byNode = new Map()
  for (const [target, owner] of fixed) {
    const path = target.slice(owner.length + 1)
    checkDirectory(nodes.get(owner), path)
    if (nodes.get(owner).files.get(path)?.data === undefined) continue
    if (!byNode.has(owner)) byNode.set(owner, new Set())
    byNode.get(owner).add(path)
  }
  return byNode
}

// As fixBin tells it, reading only the first 2048 bytes.
function hasCrlfShebang(data) {
  if (data[0] !== 0x23 || data[1] !== 0x21) return false
  const newline = data.subarray(0, 2048).indexOf(0x0a)
  return newline >= 4 && data[newline - 1] === 0x0d
}

// pnpm rewrites the `#!` line by reading and writing the file as UTF-8,
// which would change one that is not.
export function fixBin(file, where, major) {
  if (major >= 12) return { data: file.data, mode: file.mode | 0o111 }
  if (!hasCrlfShebang(file.data)) return { data: file.data, mode: 0o755 }
  try {
    decoder.decode(file.data)
  } catch {
    throw new DeptreeError('a bin with a CRLF `#!` line is not UTF-8, which pnpm would rewrite', where)
  }
  const newline = file.data.indexOf(0x0a)
  const data = new Uint8Array(file.data.length - 1)
  data.set(file.data.subarray(0, newline - 1))
  data.set(file.data.subarray(newline), newline - 1)
  return { data, mode: 0o755 }
}

const BIN_FIELDS = (manifest) => JSON.stringify([manifest.name, manifest.version, manifest.bin, manifest.directories?.bin])

// A patch is applied between two links of its package's bins, so it may
// not change what either does. `patched` is the package's files, patched;
// `targets` those fixBin runs on. It gives back the patched package.json.
export function checkPatchOfBins(node, patched, targets, where, major) {
  const file = patched.get('package.json')
  if (file?.data === undefined) throw new DeptreeError('the patch removes package.json', where)
  const manifest = file.data === node.files.get('package.json').data ? node.manifest : parseManifest(file, where)
  if (BIN_FIELDS(manifest) !== BIN_FIELDS(node.manifest)) throw new DeptreeError('the patch changes the name, version or bins package.json gives, which pnpm reads both before and after it', where)
  const was = binsOf(node, node.manifest, node.files, major)
  const is = binsOf(node, manifest, patched, major)
  for (const path of new Set([...was.keys(), ...is.keys()])) {
    if (was.has(path) !== is.has(path)) throw new DeptreeError(`the patch changes whether ${quote(path)} is a bin, which pnpm reads both before and after it`, where)
    if (JSON.stringify(was.get(path)) !== JSON.stringify(is.get(path))) throw new DeptreeError(`the patch changes the commands that name ${quote(path)}, or the name or version they are ranked by, which pnpm reads both before and after it`, where)
    if ((node.files.get(path)?.data !== undefined) !== (patched.get(path)?.data !== undefined)) {
      throw new DeptreeError(`the patch makes or removes ${quote(path)}, which a bin names, and which pnpm links before and after it`, where)
    }
  }
  // pnpm 12 rewrites no bin.
  if (major >= 12) return manifest
  for (const path of targets) {
    const before = node.files.get(path).data
    const after = patched.get(path).data
    if (before !== after && (hasCrlfShebang(before) || hasCrlfShebang(after))) throw new DeptreeError(`the patch changes ${quote(path)}, a bin with a CRLF \`#!\` line, which pnpm rewrites before and after it`, where)
  }
  return manifest
}
