// A package's commands, as pnpm reads them to link its bins
// (@pnpm/package-bins; with pnpm 12, its bin_resolver crate), and which of
// two of one name in a .bin directory pnpm links.
//
// A package's bins are its `bin` — a path, or paths by command — or, with
// none, every file under `directories.bin` that is not a dotfile or in a
// dot directory, each by its name. A command that is not a name, or a
// path that leads out of the package, is passed over, as pnpm 11 passes
// over one named `.` or `..` or nothing. pnpm 12 reads a package.json as it
// is, and its bins otherwise: see commands12.
//
// Of two commands of one name, pnpm links the one the package of that
// name has (with pnpm 11 and 12, or npm's `npx`, and pnpm's `pn`, `pnpx`,
// `pnx` and `pnpm`), else the one of the package whose name sorts last (by
// `localeCompare`, read here as English; with pnpm 12, the one whose name
// sorts first by its bytes), else of the later version, else the first it
// came to.

import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { basename, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { byBytes } from './order.js'

// A package whose directory has no package.json is still linked by these
// names by pnpm 10, to the runtime's binary inside it.
const RUNTIMES = { __proto__: null, node: 'bin/node', deno: 'deno', bun: 'bun' }

// The packages pnpm 11 and 12 take to own a command by a name not their own.
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
export const UNKNOWN = { unknown: true }

// The files of `files` under `dir`, as tinyglobby's `**` finds them: none
// a dotfile or in a dot directory, unless `dots`, as pnpm 12's walk finds
// them. `files` holds paths relative to `base`.
function filesUnder(files, base, dir, { dots = false } = {}) {
  const prefix = dir === base ? '' : `${dir.slice(base.length + 1)}/`
  const found = []
  for (const [path, file] of files) {
    if (file.data === undefined || !path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (!dots && rest.split('/').some((name) => name.startsWith('.'))) continue
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
  if (major === 11 && name in Object.prototype) throw new DeptreeError(`two bins are named ${quote(name)}, which pnpm 11 fails on`, where)
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

// What pnpm 12 takes for a command's name: one encodeURIComponent leaves
// as it is, or `$`, but neither `.` nor `..`.
const safeName = (name) => name === '$' || (name !== '.' && name !== '..' && /^[\w\-.!~*'()]+$/u.test(name))

// A package's commands as pnpm 12 reads them: a string `bin` names one
// after the package, where it has a name; an object names each of its
// string values; any other `bin` but '' names none, and only '' or none
// at all leaves directories.bin, where it is a string, to name each file
// under it, dotfiles and those in dot directories among them, by its
// name. A scoped command drops its scope; a name that is not safe, or a
// target that is absolute or out of the package, is passed over.
//
// pnpm 12 reads a package's own bins off what its store holds of its
// package.json where it has the package already, which leaves out a null
// `bin`, and off the package.json where it fetches the package, which
// keeps one: so a null `bin` beside a directories.bin is refused.
function commands12(dir, manifest, files, base, where) {
  const name = typeof manifest.name === 'string' ? manifest.name : undefined
  const common = { pkgName: name ?? '', pkgVersion: manifest.version, owner: base }
  const { bin } = manifest
  if (bin === null && typeof manifest.directories?.bin === 'string' && files !== undefined && dir === base) {
    throw new DeptreeError('its bin is null beside a directories.bin, which pnpm 12 links as its store has the package or not', where)
  }
  if (bin !== undefined && bin !== '') {
    const entries = typeof bin === 'string' ? (name === undefined ? [] : [[name, bin]])
      : bin !== null && typeof bin === 'object' && !Array.isArray(bin) ? Object.entries(bin).filter(([, rel]) => typeof rel === 'string') : []
    const commands = []
    for (const [command, rel] of entries) {
      const unscoped = command[0] === '@' && command.includes('/') ? command.slice(command.indexOf('/') + 1) : command
      if (!safeName(unscoped) || rel.startsWith('/')) continue
      const target = inPackage(dir, rel, where)
      if (target !== undefined) commands.push({ ...common, name: unscoped, target })
    }
    return commands
  }
  const binDir = manifest.directories?.bin
  if (typeof binDir !== 'string') return []
  const root = binDir === '' ? dir : inPackage(dir, binDir, where)
  if (root === undefined || binDir.startsWith('/')) return []
  if (files === undefined) return [UNKNOWN]
  const found = filesUnder(files, base, root, { dots: true }).filter((path) => safeName(basename(path)))
  const names = found.map((path) => basename(path))
  return found.map((path, i) => ({ ...common, name: names[i], target: path === '' ? root : `${root}/${path}`, unordered: names.indexOf(names[i]) !== names.lastIndexOf(names[i]) }))
}

// A package's commands: `dir` is where the package is, `manifest` its
// package.json, `files` the files of the package holding it (itself, or
// the one that bundles it), by their paths under `base`. Both are
// undefined for a directory outside the tree, a project or one a `link:`
// leads to, whose commands are known only where its package.json names
// them, and whose files are not fixed.
export function commandsOf(dir, manifest, files, base, where, major) {
  if (major >= 12) return commands12(dir, manifest, files, base, where)
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

// compareCommandsInConflict, which pnpm keeps the greater of; with pnpm 12,
// pick_winner, whose ties keep the first.
export function compare(a, b, where, major) {
  if (major >= 12) {
    const aOwns = owns(a, major, where)
    const bOwns = owns(b, major, where)
    if (aOwns !== bOwns) return aOwns ? 1 : -1
    if (a.pkgName !== b.pkgName) return byBytes(b.pkgName, a.pkgName)
    const versions = [a.pkgVersion, b.pkgVersion].map((version) => (typeof version === 'string' ? valid(version) : null))
    return versions.includes(null) ? 0 : compareVersions(versions[0], versions[1])
  }
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
export function normalized(manifest, where) {
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

export function parseManifest(file, where) {
  try {
    const manifest = JSON.parse(decoder.decode(file.data))
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
export function bundledCommands(node, where, major) {
  const commands = []
  for (const name of bundledIn(node.files)) {
    const here = `${where}: node_modules/${name}`
    const file = node.files.get(`node_modules/${name}/package.json`)
    const dir = `${node.dir}/node_modules/${name}`
    if (file !== undefined) {
      const manifest = parseManifest(file, here)
      commands.push(...commandsOf(dir, major >= 12 ? manifest : normalized(manifest, here), node.files, node.dir, here, major))
    } else if (major >= 12) {
      continue
    } else if (major >= 11) {
      throw new DeptreeError('it bundles a package with no package.json, whose bins pnpm 11 looks for above it', here)
    } else if (name in RUNTIMES) {
      commands.push({ name, target: `${dir}/${RUNTIMES[name]}`, owner: node.dir, own: true, pkgName: '', pkgVersion: '' })
    }
  }
  return commands
}

// Every path the package at `node` and those it bundles name as bins,
// relative to it, whether pnpm links them or not, where its package.json
// is `manifest` and its files are `files`: each with the commands that
// name it and the package name and version each is ranked by.
export function binsOf(node, manifest, files, major) {
  const where = quote(node.key)
  const bins = new Map()
  for (const { target, name, pkgName, pkgVersion } of [...commandsOf(node.dir, manifest, files, node.dir, where, major), ...bundledCommands({ ...node, files }, where, major)]) {
    const path = target.slice(node.dir.length + 1)
    bins.set(path, [...bins.get(path) ?? [], JSON.stringify([name, pkgName, pkgVersion])].sort())
  }
  return bins
}
