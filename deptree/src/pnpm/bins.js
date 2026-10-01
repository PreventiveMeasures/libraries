// What pnpm does to the files its bins run (@pnpm/link-bins, and
// bin-links' fixBin): no .bin directory is written here, but each file a
// bin pnpm links runs is left as linking leaves it, executable and, where
// it starts with a `#!` line that ends in CRLF, with that line ending in
// LF instead. pnpm 10 gives it mode 0o755, and pnpm 11 adds 0o111 to its
// mode where that lacks any of it, which for the 0o644 and 0o755 a
// package's files have here is the same.
//
// pnpm links a package's commands (commands.js) into many .bin
// directories, and runs fixBin on a file only where its command is the
// one linked by that name there and the file is there:
//
//  - each package's own node_modules/.bin, for its children's bins (or,
//    where a child is a `link:`, for whatever is beside it), and for those
//    of the packages it bundles;
//  - node_modules/.pnpm/node_modules/.bin, for what is privately hoisted;
//  - each project's node_modules/.bin, for its direct dependencies' bins,
//    and at the root, where anything is publicly hoisted, for all it holds,
//    a direct dependency's command over a hoisted one's; with pnpm 11 and
//    autoInstallPeers, then for the bins of each peer a direct dependency
//    requires, by names not linked there yet;
//  - where any patch is configured, each package that is patched or has
//    an install script is built, scripts or not, which links its own bins
//    beside its children's in its own .bin before its patch is applied.
//
// Where the command linked of two of one name is the first pnpm came to
// by the order a directory is read in, which varies, and a file's mode or
// text would turn on it, the tree is refused; so it is where that would
// turn on the commands of a directory outside the tree that are not known
// here, which may take any name: those of one a `link:` leads to whose
// package.json is not given (local.js), or of a project or such a
// directory by the files of its directories.bin. So is a patch that
// would be applied between two links of a file whose fix it would
// change: one that makes or removes a file a bin names, or one under a
// directories.bin, changes a bin file with a CRLF `#!` line, or changes
// the bins a package.json names, its own or a bundled package's, or the
// name or version they are ranked by.
//
// pnpm 12 (its cmd-shim crate) only adds the 0o111 a file lacks, and
// rewrites no `#!` line. It links each package's own bins into its own
// .bin, beside its children's that the lockfile says have some and those
// of the packages it bundles, in one go and with no build pass; a `link:`
// child's take no part. A bin it links whose target is a directory fails
// the install.
//
// pnpm 11 and 12 link a command named `node` without making its file
// executable; but pnpm 12 links a project's bins again after it has
// patched any package, publicly hoisted any with bins, or where its
// dependencies' peers it installs have some, and there makes the file of
// a direct dependency's `node` executable, where its link leads to it
// already.

import { DeptreeError, quote } from '../error.js'
import { UNKNOWN, binsOf, bundledCommands, commandsOf, compare, normalized, parseManifest } from './commands.js'

const decoder = new TextDecoder('utf-8', { fatal: true })

// Where the peers pnpm 11 links the bins of into a project's .bin lead:
// each peer a direct dependency has that is not optional and that its
// snapshot resolves, by the path of its link beside the dependency, in
// the order of those paths.
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

// Whether pnpm builds a package, as its pkgRequiresBuild tells: an
// install script, a binding.gyp, which pnpm 11 and 12 pass over where
// package.json's gypfile is false, or a .hooks directory.
export const requiresBuild = (manifest, files, major) => Boolean((manifest.scripts != null && (manifest.scripts.preinstall || manifest.scripts.install || manifest.scripts.postinstall))
  || (files.has('binding.gyp') && !(major >= 11 && manifest.gypfile === false)) || files.keys().some((path) => /^\.hooks[\\/]/u.test(path)))

// What linking commands into .bin directories fixes: `fixed`, by each
// file's path in the tree, the package it is in, and `contested`, of those
// that may be fixed or not, the package and why. `link` links commands
// into one directory, where `ordered` says whether the order they come in
// is one pnpm always has, and `fixNode` whether pnpm 12 fixes the file of
// a direct dependency's `node`; it gives back the names linked, and
// whether others may be.
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

// The files pnpm runs fixBin on, by the directory of the package they
// are in: `nodes` is the graph by directory, each node with its package's
// `files` and `manifest`; `projects` each project's package.json by its
// directory, `direct` each project's direct dependencies, `links` every
// link in the tree, `publicHoist` whether anything is publicly hoisted,
// `building` whether any patch is configured, `peers` whether peers are
// installed automatically, and `major` pnpm's major version.
export function binTargets({ nodes, projects, direct, links, publicHoist, building, peers, major }) {
  const commandCache = new Map()
  const commandsOfDir = (dir, { normalize = false } = {}) => {
    const node = nodes.get(dir)
    if (node !== undefined) {
      if (!commandCache.has(dir)) commandCache.set(dir, commandsOf(dir, node.manifest, node.files, dir, quote(node.key), major))
      return commandCache.get(dir)
    }
    // A project, or a directory a `link:` leads to, whose bins are outside
    // the tree but may take a name; one whose package.json is not given
    // (local.js) may take any.
    const manifest = projects.get(dir)
    if (manifest === undefined) return [UNKNOWN]
    const where = `manifests[${quote(dir)}]`
    return commandsOf(dir, normalize ? normalized(manifest, where) : manifest, undefined, undefined, where, major)
  }
  // Whether pnpm 12 takes a node to have bins: the lockfile says it has,
  // or it is a directory, for which the lockfile says nothing.
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
      // pnpm 12 links what it hoists of the projects apart, before.
      const entries = [...links].filter(([path, dir]) => /^node_modules\/(?:@[^/]+\/)?[^/@.][^/]*$/u.test(path)
        && (major < 12 || own.has(path.slice('node_modules/'.length)) || mayHaveBin(dir)))
      const commands = entries.flatMap(([path, dir]) => commandsOfDir(dir).map((command) => ({ ...command, direct: own.has(path.slice('node_modules/'.length)) })))
      const names = new Set(commands.filter((command) => command.direct).map(({ name }) => name))
      relink ||= major >= 12 && entries.some(([path, dir]) => !own.has(path.slice('node_modules/'.length)) && mayHaveBin(dir))
      linked = link([...commands.filter((command) => command.direct), ...commands.filter((command) => !command.direct && !names.has(command.name))], { ordered: false, where, fixNode: relink })
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

// The files `fixed` has fixBin run on, by the directory of their package.
// One `contested` may be or not, which is refused, unless it is fixed
// anyway, is not there, or is one fixBin leaves as it is: executable, with
// no CRLF `#!` line, and not patched.
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


// Whether a file starts with a `#!` line ending in CRLF, as fixBin reads
// its first 2048 bytes to tell.
function hasCrlfShebang(data) {
  if (data[0] !== 0x23 || data[1] !== 0x21) return false
  const newline = data.subarray(0, 2048).indexOf(0x0a)
  return newline >= 4 && data[newline - 1] === 0x0d
}

// fixBin on a file: mode 0o755, and a CRLF ending the `#!` line made LF.
// pnpm reads and writes the file as UTF-8 to do that, which would change
// one that is not; that is refused. pnpm 12 only adds the 0o111 it lacks.
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

// A patch is applied between two times its package's bins are linked,
// so it may not change what either does: `patched` is the package's files
// with the patch applied, `targets` those that fixBin is run on. pnpm
// reads package.json again after it, for the name and version a command
// is taken by as well as the bins. It gives back the package's
// package.json, patched, as parsed.
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
