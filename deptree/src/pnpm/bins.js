// What pnpm does to the files its bins run (@pnpm/link-bins, and
// bin-links' fixBin): no .bin directory is written here, but each file a
// bin pnpm links runs is left as linking leaves it, executable and, where
// it starts with a `#!` line that ends in CRLF, with that line ending in
// LF instead. pnpm 10 gives it mode 0o755, and pnpm 11 adds 0o111 to its
// mode where that lacks any of it, which for the 0o644 and 0o755 a
// package's files have here is the same.
//
// A package's bins are its `bin` — a path, or paths by command — or, with
// none, every file under `directories.bin` that is not a dotfile or in a
// dot directory, each by its name. A command that is not a name, or a
// path that leads out of the package, is passed over, as pnpm 11 passes
// over one named `.` or `..` or nothing. pnpm links bins into many .bin
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
// Of two commands of one name in a directory, pnpm links the one the
// package of that name has (with pnpm 11, or npm's `npx`, and pnpm's
// `pn`, `pnpx`, `pnx` and `pnpm`), else the one of the package whose name
// sorts last (by `localeCompare`, read here as English), else of the
// later version, else the first it came to. Where that first is by the
// order a directory is read in, which varies, and a file's mode or text
// would turn on it, the tree is refused; so it is where that would turn
// on the commands of a directory outside the tree that are not known
// here, which may take any name: those of one a `link:` leads to whose
// package.json is not given (local.js), or of a project or such a
// directory by the files of its directories.bin. So is a patch that
// would be applied between two links of a file whose fix it would
// change: one that makes or removes a file a bin names, or one under a
// directories.bin, changes a bin file with a CRLF `#!` line, or changes
// the bins a package.json names, its own or a bundled package's, or the
// name or version they are ranked by.

import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { basename, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// A package whose directory has no package.json is still linked by these
// names by pnpm 10, to the runtime's binary inside it.
const RUNTIMES = { __proto__: null, node: 'bin/node', deno: 'deno', bun: 'bun' }

// The packages pnpm 11 takes to own a command by a name not their own.
const OWNERS = { __proto__: null, npx: ['npm'], pn: ['pnpm', '@pnpm/exe'], pnpm: ['@pnpm/exe'], pnpx: ['pnpm', '@pnpm/exe'], pnx: ['pnpm', '@pnpm/exe'] }

const collator = new Intl.Collator('en')
const decoder = new TextDecoder('utf-8', { fatal: true })

// The path `rel` names in the package at `dir`, as path.join spells it, or
// undefined where it is not in the package, as is-subdir tells; the
// package itself is `dir`, which is `.` for the root project.
function inPackage(dir, rel, where) {
  if (typeof rel !== 'string') throw new DeptreeError(`${quote(String(rel))} is not a path, which pnpm fails on`, where)
  const path = join(dir, rel)
  if (path.endsWith('/')) throw new DeptreeError(`${quote(rel)} ends in a slash, which is not supported`, where)
  const inside = dir === '.' ? path !== '..' && !path.startsWith('../') : path === dir || path.startsWith(`${dir}/`)
  return inside ? path : undefined
}

// A command that stands for those of a directory whose bins are not known
// here, which may take any name.
const UNKNOWN = { unknown: true }

// The files of `files` under `dir`, as tinyglobby's `**` finds them: none
// a dotfile or in a dot directory. `files` holds paths relative to `base`.
function filesUnder(files, base, dir) {
  const prefix = dir === base ? '' : `${dir.slice(base.length + 1)}/`
  const found = []
  for (const [path, file] of files) {
    if (file.data === undefined || !path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest.split('/').some((name) => name.startsWith('.'))) continue
    found.push(rest)
  }
  return found
}

// Whether pnpm takes a package to own a command, which wins it the name.
// pnpm 11 looks a name up among OWNERS as a plain object's key, and fails
// on one that Object.prototype has.
function owns({ name, pkgName, own }, major, where) {
  if (own || name === pkgName) return true
  if (major < 11) return false
  if (name in Object.prototype) throw new DeptreeError(`two bins are named ${quote(name)}, which pnpm 11 fails on`, where)
  return OWNERS[name]?.includes(pkgName) === true
}

// pnpm's runtimeHasNodeDownloaded: whether engines.runtime asks for a Node
// to download, the first runtime of a list named node deciding. pnpm fails
// on a list with nothing in it where it reads one, before that.
function downloadsNode(runtime, where) {
  if (!runtime) return false
  if (!Array.isArray(runtime)) return runtime.name === 'node' && runtime.onFail === 'download'
  for (const item of runtime) {
    if (item === null || item === undefined) throw new DeptreeError('its engines.runtime lists nothing where pnpm reads a runtime, which pnpm fails on', where)
    if (item.name === 'node') return item.onFail === 'download'
  }
  return false
}

// A package's commands: `dir` is where the package is, `manifest` its
// package.json, `files` the files of the package holding it (itself, or
// the one that bundles it), by their paths under `base`. Both are
// undefined for a directory outside the tree, a project or one a `link:`
// leads to, whose commands are known only where its package.json names
// them, and whose files are not fixed.
function commandsOf(dir, manifest, files, base, where, major) {
  const common = { pkgName: manifest.name, pkgVersion: manifest.version, owner: base }
  if (typeof manifest.bin === 'string' && !manifest.name) throw new DeptreeError('it has a bin and no name, which pnpm fails on', where)
  // pnpm looks for the Node it would download from where the package is,
  // and fails where there is none.
  if (downloadsNode(manifest.engines?.runtime, where)) {
    throw new DeptreeError('its engines.runtime has pnpm look for a Node to run its bins with, which is not supported', where)
  }
  if (manifest.bin) {
    const entries = typeof manifest.bin === 'string' ? [[manifest.name, manifest.bin]] : Object.entries(manifest.bin)
    const commands = []
    for (const [command, rel] of entries) {
      const name = command[0] === '@' ? command.slice(command.indexOf('/') + 1) : command
      if (name !== encodeURIComponent(name) && name !== '$') continue
      if (name === '' || name === '.' || name === '..') {
        if (major >= 11) continue
        throw new DeptreeError(`a bin named ${quote(name)} is not supported`, where)
      }
      const target = inPackage(dir, rel, where)
      if (target !== undefined) commands.push({ ...common, name, target })
    }
    return commands
  }
  const binDir = manifest.directories?.bin
  if (!binDir) return []
  const root = inPackage(dir, binDir, where)
  if (root === undefined) return []
  if (files === undefined) return [UNKNOWN]
  const found = filesUnder(files, base, root)
  // tinyglobby lists them in the order the directories are read in,
  // which decides between two of one name.
  const names = found.map((path) => basename(path))
  return found.map((path, i) => ({ ...common, name: names[i], target: `${root}/${path}`, unordered: names.indexOf(names[i]) !== names.lastIndexOf(names[i]) }))
}

// compareCommandsInConflict, which pnpm keeps the greater of.
function compare(a, b, where, major) {
  const aOwns = owns(a, major, where)
  const bOwns = owns(b, major, where)
  if (aOwns !== bOwns) return aOwns ? 1 : -1
  if (a.pkgName !== b.pkgName) {
    if (typeof a.pkgName !== 'string' || typeof b.pkgName !== 'string') throw new DeptreeError(`two bins named ${quote(a.name)} are of packages not both named, which pnpm fails on`, where)
    return collator.compare(a.pkgName, b.pkgName)
  }
  if (valid(a.pkgVersion) === null || valid(b.pkgVersion) === null) throw new DeptreeError(`two bins named ${quote(a.name)} are of ${quote(a.pkgName)} at versions pnpm cannot compare, which it fails on`, where)
  return compareVersions(a.pkgVersion, b.pkgVersion)
}

// A package.json as normalize-package-data leaves one, or refuses it,
// where pnpm reads one with readPackageJson: its name trimmed, and each
// of its name and version one npm takes.
function normalized(manifest, where) {
  const name = manifest.name ? manifest.name : ''
  if (typeof name !== 'string') throw new DeptreeError('its package.json\'s name is not a string, which pnpm fails on', where)
  const trimmed = name.trim()
  const scoped = /^@([^/]+)\/([^/]+)$/u.exec(trimmed)
  const encoded = (part) => part === encodeURIComponent(part)
  const validName = trimmed === '' || (!trimmed.startsWith('.') && trimmed.toLowerCase() !== 'node_modules' && trimmed.toLowerCase() !== 'favicon.ico'
    && ((scoped !== null && encoded(scoped[1]) && encoded(scoped[2])) || (!/[/@\s+%:]/u.test(trimmed) && encoded(trimmed))))
  if (!validName) throw new DeptreeError(`its package.json's name, ${quote(trimmed)}, is one pnpm fails on`, where)
  const version = manifest.version ? valid(manifest.version, { loose: true }) : ''
  if (version === null) throw new DeptreeError(`its package.json's version, ${quote(String(manifest.version))}, is one pnpm fails on`, where)
  return { ...manifest, name: trimmed, version }
}

// The packages a package bundles, as pnpm's readModulesDir finds them in
// its node_modules: each directory there not named with a leading dot,
// and each in a scope's directory.
function bundledIn(files) {
  const names = new Set()
  for (const path of files.keys()) {
    const parts = path.split('/')
    if (parts[0] !== 'node_modules' || parts.length < 3 || parts[1].startsWith('.')) continue
    if (!parts[1].startsWith('@')) names.add(parts[1])
    else if (parts.length > 3) names.add(`${parts[1]}/${parts[2]}`)
  }
  return [...names]
}

function parseManifest(file, where) {
  try {
    const manifest = JSON.parse(decoder.decode(file.data).replace(/^﻿/u, ''))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not an object')
    return manifest
  } catch {
    throw new DeptreeError('a package.json pnpm reads for its bins is not JSON, which pnpm fails on', where)
  }
}

// The commands of the packages `node` bundles. For one with no
// package.json pnpm 11 reads the bins of the package.json of the nearest
// directory above it whose publishConfig.directory it is, as far up as the
// filesystem goes, which is refused.
function bundledCommands(node, where, major) {
  const commands = []
  for (const name of bundledIn(node.files)) {
    const here = `${where}: node_modules/${name}`
    const file = node.files.get(`node_modules/${name}/package.json`)
    const dir = `${node.dir}/node_modules/${name}`
    if (file !== undefined) {
      commands.push(...commandsOf(dir, normalized(parseManifest(file, here), here), node.files, node.dir, here, major))
    } else if (major >= 11) {
      throw new DeptreeError('it bundles a package with no package.json, whose bins pnpm 11 looks for above it', here)
    } else if (name in RUNTIMES) {
      commands.push({ name, target: `${dir}/${RUNTIMES[name]}`, owner: node.dir, own: true, pkgName: '', pkgVersion: '' })
    }
  }
  return commands
}

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
// install script, a binding.gyp or a .hooks directory.
const hasInstallScript = (manifest, files) => Boolean((manifest.scripts != null && (manifest.scripts.preinstall || manifest.scripts.install || manifest.scripts.postinstall))
  || files.has('binding.gyp') || [...files.keys()].some((path) => /^\.hooks[\\/]/u.test(path)))

// The files pnpm runs fixBin on, by the directory of the package they
// are in: `nodes` is the graph by directory, each node with its package's
// `files` and `manifest`; `projects` each project's package.json by its
// directory, `direct` each project's direct dependencies, `links` every
// link in the tree, `publicHoist` whether anything is publicly hoisted,
// `building` whether any patch is configured, `peers` whether peers are
// installed automatically, and `major` pnpm's major version.
export function binTargets({ nodes, projects, direct, links, publicHoist, building, peers, major }) {
  const commandCache = new Map()
  const commandsOfDir = (dir, { raw = false } = {}) => {
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
    return commandsOf(dir, raw ? manifest : normalized(manifest, where), undefined, undefined, where, major)
  }

  // By each file's path in the tree, the package it is in; and of those
  // that may be fixed or not, why.
  const fixed = new Map()
  const contested = new Map()
  // One linking of commands into a directory: `ordered` says whether the
  // order they come in is one pnpm always has, and `blind` whether a
  // command not known here may be among them. It gives back the names
  // linked, and whether others may be.
  const link = (commands, { ordered, blind = false, where }) => {
    const unknown = blind || commands.some((command) => command.unknown)
    const best = new Map()
    for (const command of commands) {
      if (command.unknown) continue
      const tied = best.get(command.name)
      const order = tied === undefined ? 1 : compare(command, tied[0], where, major)
      if (order > 0) best.set(command.name, [command])
      else if (order === 0) tied.push(command)
    }
    for (const tied of best.values()) {
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

  for (const node of nodes.values()) {
    const where = quote(node.key)
    const children = [...node.children.values()]
    const withBins = children.filter((dir) => nodes.get(dir)?.pkg.hasBin).flatMap((dir) => commandsOfDir(dir))
    if (children.every((dir) => nodes.has(dir))) link(withBins, { ordered: true, where })
    else link(children.flatMap((dir) => commandsOfDir(dir)), { ordered: false, where })
    if (node.pkg.bundledDependencies !== undefined) link(bundledCommands(node, where, major), { ordered: false, where })
    if (building && (node.pkg.patchHash !== undefined || hasInstallScript(node.manifest, node.files))) {
      link([...withBins, ...commandsOfDir(node.dir)], { ordered: true, where })
    }
  }

  const PRIVATE = 'node_modules/.pnpm/node_modules/'
  const hoisted = [...links].filter(([path, dir]) => path.startsWith(PRIVATE) && nodes.get(dir)?.pkg.hasBin)
  link(hoisted.flatMap(([, dir]) => commandsOfDir(dir, { raw: true })), { ordered: true, where: quote(PRIVATE.slice(0, -1)) })

  for (const [id, children] of direct) {
    const where = `importers[${quote(id)}]`
    let linked
    if (id === '.' && publicHoist) {
      const manifest = projects.get('.')
      const own = new Set(Object.keys({ ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }))
      const entries = [...links].filter(([path]) => /^node_modules\/(?:@[^/]+\/)?[^/@.][^/]*$/u.test(path))
      const commands = entries.flatMap(([path, dir]) => commandsOfDir(dir, { raw: true }).map((command) => ({ ...command, direct: own.has(path.slice('node_modules/'.length)) })))
      const names = new Set(commands.filter((command) => command.direct).map(({ name }) => name))
      linked = link([...commands.filter((command) => command.direct), ...commands.filter((command) => !command.direct && !names.has(command.name))], { ordered: false, where })
    } else {
      // pnpm 11 reads the bins only of what the lockfile says has some.
      const dirs = [...children.values()].filter((dir) => major < 11 || (nodes.get(dir)?.pkg.hasBin ?? true))
      linked = link(dirs.flatMap((dir) => commandsOfDir(dir, { raw: true })), { ordered: true, where })
    }
    if (major >= 11 && peers) {
      const commands = peersOf(children, nodes).flatMap((dir) => commandsOfDir(dir, { raw: true }))
      link(commands.filter(({ name }) => !linked.names.has(name)), { ordered: true, blind: linked.unknown, where })
    }
  }

  return fixedFiles(nodes, fixed, contested)
}

// The files `fixed` has fixBin run on, by the directory of their package.
// One `contested` may be or not, which is refused, unless it is fixed
// anyway, is not there, or is one fixBin leaves as it is: executable, with
// no CRLF `#!` line, and not patched.
function fixedFiles(nodes, fixed, contested) {
  for (const [target, { owner, why }] of contested) {
    const node = nodes.get(owner)
    const path = target.slice(owner.length + 1)
    const file = node.files.get(path)
    if (fixed.has(target) || file?.data === undefined || (file.mode === 0o755 && !hasCrlfShebang(file.data) && node.pkg.patchHash === undefined)) continue
    throw new DeptreeError(`whether pnpm makes ${quote(path)} executable turns on ${why}`, quote(node.key))
  }
  const byNode = new Map()
  for (const [target, owner] of fixed) {
    const path = target.slice(owner.length + 1)
    if (nodes.get(owner).files.get(path)?.data === undefined) continue
    if (!byNode.has(owner)) byNode.set(owner, new Set())
    byNode.get(owner).add(path)
  }
  return byNode
}

// Every path the package at `node` and those it bundles name as bins,
// relative to it, whether pnpm links them or not, where its package.json
// is `manifest` and its files are `files`: each with the commands that
// name it and the package name and version each is ranked by.
function binsOf(node, manifest, files, major) {
  const where = quote(node.key)
  const bins = new Map()
  for (const { target, name, pkgName, pkgVersion } of [...commandsOf(node.dir, manifest, files, node.dir, where, major), ...bundledCommands({ ...node, files }, where, major)]) {
    const path = target.slice(node.dir.length + 1)
    bins.set(path, [...bins.get(path) ?? [], JSON.stringify([name, pkgName, pkgVersion])].sort())
  }
  return bins
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
// one that is not; that is refused.
export function fixBin(file, where) {
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
  for (const path of targets) {
    const before = node.files.get(path).data
    const after = patched.get(path).data
    if (before !== after && (hasCrlfShebang(before) || hasCrlfShebang(after))) throw new DeptreeError(`the patch changes ${quote(path)}, a bin with a CRLF \`#!\` line, which pnpm rewrites before and after it`, where)
  }
  return manifest
}
