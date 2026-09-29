// What pnpm 10 does to the files its bins run (@pnpm/link-bins, and
// bin-links' fixBin): no .bin directory is written here, but each file a
// bin pnpm links runs is left as linking leaves it, given mode 0o755 and,
// where it starts with a `#!` line that ends in CRLF, with that line
// ending in LF instead.
//
// A package's bins are its `bin` — a path, or paths by command — or, with
// none, every file under `directories.bin` that is not a dotfile or in a
// dot directory, each by its name. A command that is not a name, or a
// path that leads out of the package, is passed over. pnpm links bins
// into many .bin directories, and runs fixBin on a file only where its
// command is the one linked by that name there and the file is there:
//
//  - each package's own node_modules/.bin, for its children's bins (or,
//    where a child is a `link:`, for whatever is beside it), and for those
//    of the packages it bundles;
//  - node_modules/.pnpm/node_modules/.bin, for what is privately hoisted;
//  - each project's node_modules/.bin, for its direct dependencies' bins,
//    and at the root, where anything is publicly hoisted, for all it holds,
//    a direct dependency's command over a hoisted one's;
//  - where any patch is configured, each package that is patched or has
//    an install script is built, scripts or not, which links its own bins
//    beside its children's in its own .bin before its patch is applied.
//
// Of two commands of one name in a directory, pnpm links the one the
// package of that name has, else the one of the package whose name sorts
// last (by `localeCompare`, read here as English), else of the later
// version, else the first it came to. Where that first is by the order a
// directory is read in, which varies, and a file's mode or text would
// turn on it, the tree is refused. So is a patch that would be applied
// between two links of a file whose fix it would change: one that makes
// or removes a file a bin names, changes a bin file with a CRLF `#!`
// line, or changes the bins its package.json names.

import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// A package whose directory has no package.json is still linked by these
// names, to the runtime's binary inside it.
const RUNTIMES = { __proto__: null, node: 'bin/node', deno: 'deno', bun: 'bun' }

const collator = new Intl.Collator('en')
const decoder = new TextDecoder('utf-8', { fatal: true })

// The path `rel` names in the package at `dir`, as path.join spells it, or
// undefined where it is not in the package; the package itself is `dir`.
function inPackage(dir, rel, where) {
  if (typeof rel !== 'string') throw new DeptreeError(`${quote(String(rel))} is not a path, which pnpm fails on`, where)
  const path = join(`/${dir}`, rel).slice(1)
  if (path.endsWith('/') && path !== '/') throw new DeptreeError(`${quote(rel)} ends in a slash, which is not supported`, where)
  return path === dir || path.startsWith(`${dir}/`) ? path : undefined
}

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

// A package's commands: `dir` is where the package is, `manifest` its
// package.json, `files` the files of the package holding it (itself, or
// the one that bundles it), by their paths under `base`, which is
// undefined for a project, whose files are not in the tree.
function commandsOf(dir, manifest, files, base, where) {
  const common = { pkgName: manifest.name, pkgVersion: manifest.version, owner: base }
  if (typeof manifest.bin === 'string' && !manifest.name) throw new DeptreeError('it has a bin and no name, which pnpm fails on', where)
  if (manifest.bin) {
    const entries = typeof manifest.bin === 'string' ? [[manifest.name, manifest.bin]] : Object.entries(manifest.bin)
    const commands = []
    for (const [command, rel] of entries) {
      const name = command[0] === '@' ? command.slice(command.indexOf('/') + 1) : command
      if (name !== encodeURIComponent(name) && name !== '$') continue
      if (name === '' || name === '.' || name === '..') throw new DeptreeError(`a bin named ${quote(name)} is not supported`, where)
      const target = inPackage(dir, rel, where)
      if (target !== undefined) commands.push({ ...common, name, target, ownName: name === manifest.name })
    }
    return commands
  }
  const binDir = manifest.directories?.bin
  if (!binDir) return []
  const root = inPackage(dir, binDir, where)
  if (root === undefined) return []
  const found = filesUnder(files, base, root)
  const counts = new Map()
  for (const path of found) counts.set(path.split('/').at(-1), (counts.get(path.split('/').at(-1)) ?? 0) + 1)
  // tinyglobby lists them in the order the directories are read in.
  return found.map((path) => {
    const name = path.split('/').at(-1)
    return { ...common, name, target: `${root}/${path}`, ownName: name === manifest.name, unordered: counts.get(name) > 1 }
  })
}

// compareCommandsInConflict, which pnpm keeps the greater of.
function compare(a, b, where) {
  if (a.ownName !== b.ownName) return a.ownName ? 1 : -1
  if (a.pkgName !== b.pkgName) return collator.compare(a.pkgName, b.pkgName)
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

// The commands of the packages `node` bundles.
function bundledCommands(node, where) {
  const commands = []
  for (const name of bundledIn(node.files)) {
    const here = `${where}: node_modules/${name}`
    const file = node.files.get(`node_modules/${name}/package.json`)
    const dir = `${node.dir}/node_modules/${name}`
    if (file !== undefined) {
      commands.push(...commandsOf(dir, normalized(parseManifest(file, here), here), node.files, node.dir, here))
    } else if (name in RUNTIMES) {
      commands.push({ name, target: `${dir}/${RUNTIMES[name]}`, owner: node.dir, ownName: true, pkgName: '', pkgVersion: '' })
    }
  }
  return commands
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
// and `building` whether any patch is configured.
export function binTargets({ nodes, projects, direct, links, publicHoist, building }) {
  const commandCache = new Map()
  // A `link:` that is no project leads to a directory not given here,
  // which is taken to have no bins.
  const commandsOfDir = (dir, { raw = false } = {}) => {
    const node = nodes.get(dir)
    if (node !== undefined) {
      if (!commandCache.has(dir)) commandCache.set(dir, commandsOf(dir, node.manifest, node.files, dir, quote(node.key)))
      return commandCache.get(dir)
    }
    // A project, whose bins are outside the tree but may take a name.
    const manifest = projects.get(dir)
    if (manifest === undefined) return []
    const where = `manifests[${quote(dir)}]`
    return commandsOf(dir, raw ? manifest : normalized(manifest, where), new Map(), undefined, where)
  }

  // By each file's path in the tree, the package it is in.
  const fixed = new Map()
  const contested = new Map()
  // One linking of commands into a directory: `ordered` says whether the
  // order they come in is one pnpm always has.
  const link = (commands, { ordered, where }) => {
    const groups = new Map()
    for (const command of commands) groups.set(command.name, [...(groups.get(command.name) ?? []), command])
    for (const group of groups.values()) {
      let best = [group[0]]
      for (const command of group.slice(1)) {
        const order = compare(command, best[0], where)
        if (order > 0) best = [command]
        else if (order === 0) best.push(command)
      }
      const targets = new Set(best.map(({ target }) => target))
      const unsure = targets.size > 1 && (!ordered || best.some(({ unordered }) => unordered))
      for (const { target, owner } of unsure ? best : best.slice(0, 1)) if (owner !== undefined) (unsure ? contested : fixed).set(target, owner)
    }
  }

  for (const node of nodes.values()) {
    const where = quote(node.key)
    const children = [...node.children.values()]
    if (children.every((dir) => nodes.has(dir))) {
      link(children.filter((dir) => nodes.get(dir).pkg.hasBin).flatMap((dir) => commandsOfDir(dir)), { ordered: true, where })
    } else {
      link(children.flatMap((dir) => commandsOfDir(dir)), { ordered: false, where })
    }
    if (node.pkg.bundledDependencies !== undefined) link(bundledCommands(node, where), { ordered: false, where })
    if (building && (node.pkg.patchHash !== undefined || hasInstallScript(node.manifest, node.files))) {
      link([...children.filter((dir) => nodes.get(dir)?.pkg.hasBin).flatMap((dir) => commandsOfDir(dir)), ...commandsOfDir(node.dir)], { ordered: true, where })
    }
  }

  const PRIVATE = 'node_modules/.pnpm/node_modules/'
  const hoisted = [...links].filter(([path, dir]) => path.startsWith(PRIVATE) && nodes.get(dir)?.pkg.hasBin)
  link(hoisted.flatMap(([, dir]) => commandsOfDir(dir, { raw: true })), { ordered: true, where: quote(PRIVATE.slice(0, -1)) })

  for (const [id, children] of direct) {
    const where = `importers[${quote(id)}]`
    if (id === '.' && publicHoist) {
      const manifest = projects.get('.')
      const own = new Set(Object.keys({ ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }))
      const entries = [...links].filter(([path]) => /^node_modules\/(?:@[^/]+\/)?[^/@.][^/]*$/u.test(path))
      const commands = entries.flatMap(([path, dir]) => commandsOfDir(dir, { raw: true }).map((command) => ({ ...command, direct: own.has(path.slice('node_modules/'.length)) })))
      const names = new Set(commands.filter((command) => command.direct).map(({ name }) => name))
      link([...commands.filter((command) => command.direct), ...commands.filter((command) => !command.direct && !names.has(command.name))], { ordered: false, where })
    } else {
      link([...children.values()].flatMap((dir) => commandsOfDir(dir, { raw: true })), { ordered: true, where })
    }
  }

  const byNode = new Map()
  for (const [target, owner] of new Map([...contested, ...fixed])) {
    const node = nodes.get(owner)
    const path = target.slice(owner.length + 1)
    if (node.files.get(path)?.data === undefined) continue
    if (!fixed.has(target)) throw new DeptreeError(`whether pnpm makes ${quote(path)} executable turns on the order it reads a directory in, which varies`, quote(node.key))
    if (!byNode.has(owner)) byNode.set(owner, new Set())
    byNode.get(owner).add(path)
  }
  return byNode
}

// Every path the package at `node` and those it bundles name as bins,
// relative to it, whether pnpm links them or not.
export function binPaths(node) {
  const commands = [...commandsOf(node.dir, node.manifest, node.files, node.dir, quote(node.key)), ...bundledCommands(node, quote(node.key))]
  return new Set(commands.map(({ target }) => target.slice(node.dir.length + 1)))
}

// Whether a file starts with a `#!` line ending in CRLF, as fixBin reads
// its first 2048 bytes to tell.
export function hasCrlfShebang(data) {
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
