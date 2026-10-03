// A package's commands as @pnpm/package-bins reads them to link its bins, or
// pnpm 12's bin_resolver crate, which reads a package.json unnormalized. pnpm 9
// filters a command by its name before it drops the scope, and links a `bin`
// string or a directories.bin wherever it leads.

import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { basename, compareNames, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { checkNesting } from '../manifest.js'
import { within } from '../mount.js'

// A package whose directory has no package.json is still linked by these names
// by pnpm 10, to the runtime's binary inside it; pnpm 9 links none.
const RUNTIMES = { __proto__: null, node: 'bin/node', deno: 'deno', bun: 'bun' }

// The packages pnpm 11 and 12 take to own a command by a name not their own.
const OWNERS = { __proto__: null, npx: ['npm'], pn: ['pnpm', '@pnpm/exe'], pnpm: ['@pnpm/exe'], pnpx: ['pnpm', '@pnpm/exe'], pnx: ['pnpm', '@pnpm/exe'] }

const collator = new Intl.Collator('en')
const decoder = new TextDecoder('utf-8', { fatal: true })

// As path.join spells it, or undefined where is-subdir finds it out of `dir`.
function inPackage(dir, rel, where) {
  if (typeof rel !== 'string') throw new DeptreeError(`${quote(String(rel))} is not a path, which pnpm fails on`, where)
  const path = join(dir, rel)
  if (path.endsWith('/')) throw new DeptreeError(`${quote(rel)} ends in a slash, which is not supported`, where)
  return within(dir, path) ? path : undefined
}

// Stands for the commands of a directory whose bins are not known here.
export const UNKNOWN = { unknown: true }

// As tinyglobby's `**` finds them, or with `dots` as pnpm 12's walk does.
function filesUnder(files, base, dir, { dots = false } = {}) {
  const prefix = dir === base ? '' : `${dir.slice(base.length + 1)}/`
  const found = [...files].filter(([path, file]) => file.data !== undefined && path.startsWith(prefix)).map(([path]) => path.slice(prefix.length))
  return dots ? found : found.filter((rest) => !rest.split('/').some((name) => name.startsWith('.')))
}

// Which of two of one name wins turns on the order directories are read in.
function filesAsCommands(found, root, common) {
  const names = found.map((path) => basename(path))
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return found.map((path, i) => ({ ...common, name: names[i], target: `${root}/${path}`, unordered: counts.get(names[i]) > 1 }))
}

// pnpm 11 looks a name up among OWNERS as a plain object's key, and fails on
// one that Object.prototype has.
function owns({ name, pkgName, own }, major, where) {
  if (own || name === pkgName) return true
  if (major < 11) return false
  if (major === 11 && name in Object.prototype) throw new DeptreeError(`two bins are named ${quote(name)}, which pnpm 11 fails on`, where)
  return OWNERS[name]?.includes(pkgName) === true
}

// pnpm's runtimeHasNodeDownloaded.
function downloadsNode(runtime, where) {
  if (!runtime) return false
  if (!Array.isArray(runtime)) return runtime.name === 'node' && runtime.onFail === 'download'
  for (const item of runtime) {
    if (item == null) throw new DeptreeError('its engines.runtime lists nothing where pnpm reads a runtime, which pnpm fails on', where)
    if (item.name === 'node') return item.onFail === 'download'
  }
  return false
}

// pnpm 12's command names: those encodeURIComponent leaves as they are.
const safeName = (name) => name === '$' || (name !== '.' && name !== '..' && /^[\w\-.!~*'()]+$/u.test(name))

// pnpm 12 reads a package's own package.json from its store where it has the
// package, which drops a null `bin`, and as fetched otherwise.
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
  const root = inPackage(dir, binDir, where)
  if (root === undefined || binDir.startsWith('/')) return []
  if (files === undefined) return [UNKNOWN]
  return filesAsCommands(filesUnder(files, base, root, { dots: true }).filter((path) => safeName(basename(path))), root, common)
}

const outOf = (rel, where) => new DeptreeError(`${quote(rel)} leads out of the package, which pnpm 9 links a bin to all the same, and that is not supported`, where)

const uriSafe = (name) => name === encodeURIComponent(name) || name === '$'

// pnpm 9 also takes a scope with whatever follows it.
const takes9 = (command) => uriSafe(command) || command[0] === '@'

// `files` are the holding package's (itself, or the one bundling it), by path
// under `base`; both are undefined for a project or `link:` target.
export function commandsOf(dir, manifest, files, base, where, major) {
  if (major >= 12) return commands12(dir, manifest, files, base, where)
  const common = { pkgName: manifest.name, pkgVersion: manifest.version, owner: base }
  if (typeof manifest.bin === 'string' && !manifest.name) throw new DeptreeError('it has a bin and no name, which pnpm fails on', where)
  // pnpm 9 knows no runtime.
  if (major >= 10 && downloadsNode(manifest.engines?.runtime, where)) {
    throw new DeptreeError('its engines.runtime has pnpm look for a Node to run its bins with, which is not supported', where)
  }
  if (manifest.bin) {
    const string = typeof manifest.bin === 'string'
    const entries = string ? [[manifest.name, manifest.bin]] : Object.entries(manifest.bin)
    const commands = []
    for (const [command, rel] of entries) {
      const name = command[0] === '@' ? command.slice(command.indexOf('/') + 1) : command
      if (!(major < 10 ? string || takes9(command) : uriSafe(name))) continue
      if (name === '' || name === '.' || name === '..' || name.includes('/')) {
        if (major >= 11) continue
        throw new DeptreeError(`a bin named ${quote(name)} is not supported`, where)
      }
      const target = inPackage(dir, rel, where)
      if (target === undefined && major < 10 && string) throw outOf(rel, where)
      if (target !== undefined) commands.push({ ...common, name, target })
    }
    return commands
  }
  const binDir = manifest.directories?.bin
  if (!binDir) return []
  const root = inPackage(dir, binDir, where)
  if (root === undefined && major < 10) throw outOf(binDir, where)
  if (root === undefined) return []
  if (files === undefined) return [UNKNOWN]
  return filesAsCommands(filesUnder(files, base, root), root, common)
}

// compareCommandsInConflict, which pnpm keeps the greater of (pnpm 12's
// pick_winner, which keeps the first of a tie). pnpm compares names with
// localeCompare, read here as English.
export function compare(a, b, where, major) {
  const aOwns = owns(a, major, where)
  const bOwns = owns(b, major, where)
  if (aOwns !== bOwns) return aOwns ? 1 : -1
  if (major >= 12) {
    if (a.pkgName !== b.pkgName) return compareNames(b.pkgName, a.pkgName)
    const versions = [a.pkgVersion, b.pkgVersion].map((version) => (typeof version === 'string' ? valid(version) : null))
    return versions.includes(null) ? 0 : compareVersions(versions[0], versions[1])
  }
  if (a.pkgName !== b.pkgName) {
    if (typeof a.pkgName !== 'string' || typeof b.pkgName !== 'string') throw new DeptreeError(`two bins named ${quote(a.name)} are of packages not both named, which pnpm fails on`, where)
    return collator.compare(a.pkgName, b.pkgName)
  }
  if (valid(a.pkgVersion) === null || valid(b.pkgVersion) === null) throw new DeptreeError(`two bins named ${quote(a.name)} are of ${quote(a.pkgName)} at versions pnpm cannot compare, which it fails on`, where)
  return compareVersions(a.pkgVersion, b.pkgVersion)
}

// As normalize-package-data leaves it for pnpm's readPackageJson.
export function normalized(manifest, where) {
  const name = manifest.name || ''
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

// As pnpm's readModulesDir finds them.
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
    return checkNesting(manifest, where)
  } catch (error) {
    if (error instanceof DeptreeError) throw error
    throw new DeptreeError('a package.json pnpm reads for its bins is not JSON, which pnpm fails on', where)
  }
}

// For a bundled package with no package.json, pnpm 11 reads the bins of any
// directory above it, up to /, whose publishConfig.directory it is.
export function bundledCommands(node, where, major) {
  const commands = []
  for (const name of bundledIn(node.files)) {
    const here = `${where}: node_modules/${name}`
    const file = node.files.get(`node_modules/${name}/package.json`)
    const dir = `${node.dir}/node_modules/${name}`
    if (file !== undefined) {
      const manifest = parseManifest(file, here)
      commands.push(...commandsOf(dir, major >= 12 ? manifest : normalized(manifest, here), node.files, node.dir, here, major))
    } else if (major >= 11) {
      if (major < 12) throw new DeptreeError('it bundles a package with no package.json, whose bins pnpm 11 looks for above it', here)
    } else if (major >= 10 && name in RUNTIMES) {
      commands.push({ name, target: `${dir}/${RUNTIMES[name]}`, owner: node.dir, own: true, pkgName: '', pkgVersion: '' })
    }
  }
  return commands
}

// Every path the package and those it bundles name as bins, linked or not.
export function binsOf(node, manifest, files, major) {
  const where = quote(node.key)
  const bins = new Map()
  for (const { target, name, pkgName, pkgVersion } of [...commandsOf(node.dir, manifest, files, node.dir, where, major), ...bundledCommands({ ...node, files }, where, major)]) {
    const path = target.slice(node.dir.length + 1)
    bins.set(path, [...bins.get(path) ?? [], JSON.stringify([name, pkgName, pkgVersion])].sort())
  }
  return bins
}
