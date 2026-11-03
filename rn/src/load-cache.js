// rn-serve's on-disk cache of each file as loadFile() (load.js) loads it, keyed by all its output
// depends on: the file, rn's own code, esbuild and flow-remove-types, the project's Babel config and
// what it loads or reads, and the loadFile() options that change it (--esm's among them).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs, { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { Module } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPack, readEntry, touch, writeEntry } from './load-pack.js'
import { storeOf } from './load-store.js'

// Bump to invalidate every entry.
const CACHE_FORMAT = 5
// rn's modules whose code shapes the cached output: loadFile(), Babel's worker, dev module builds, this file.
const CHAIN = ['load.js', 'babel-worker.js', 'modules.js', 'load-cache.js']
const RELATIVE = /^(?:import|export)\b[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gmu
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
// node:fs sync calls (Babel loads configs sync) that read a file, and those that only check for one.
const READS = ['readFileSync', 'readdirSync']
const LOOKS = ['existsSync', 'statSync', 'lstatSync', 'accessSync']
const NODE_MODULES = `${sep}node_modules${sep}`
const digest = (data) => createHash('sha256').update(data).digest('hex')
const memo = (map, key, make) => {
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}
const envOf = () => [process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null]

// The CHAIN modules and every rn module they import, transitively, as those shape the output too
// (worklets.js's Reanimated gate shapes Babel's, for one).
export function ownModules() {
  const paths = new Set(CHAIN.map((name) => join(import.meta.dirname, name)))
  for (const path of paths) for (const [, specifier] of readFileSync(path, 'utf8').matchAll(RELATIVE)) paths.add(join(dirname(path), specifier))
  return [...paths].toSorted()
}
const fileDigest = (path) => {
  try {
    return digest(readFileSync(path))
  } catch {
    return null
  }
}
// A JSON replacer that keeps functions and RegExps by their source.
const shown = (_, value) => (typeof value === 'function' || value instanceof RegExp ? String(value) : value)

// A path's state: if `read`, a file's digest or a directory's entries; else just 'file' or 'directory'
// (Babel and browserslist look for their configs up to the root). null if missing.
const stateOf = (path, read) => {
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat === undefined) return null
    if (!read) return stat.isDirectory() ? 'directory' : 'file'
    return stat.isDirectory() ? readdirSync(path).toSorted() : fileDigest(path)
  } catch {
    return null
  }
}

// Runs `load` (Babel's first load of a config) and returns Map<path, whether read> of the paths it read
// or only checked for through the node:fs object. A function a config keeps from it
// (`const { readFileSync } = require('node:fs')`) stops recording once `load` is done.
export function readsOf(load) {
  const reads = new Map()
  let reading = true
  const pathOf = (path) => {
    if (typeof path === 'string') return path
    if (path instanceof URL && path.protocol === 'file:') return fileURLToPath(path)
    return Buffer.isBuffer(path) ? path.toString() : null
  }
  const wrap = (original, read) =>
    function (...args) {
      const at = reading ? pathOf(args[0]) : null
      if (at !== null) {
        const full = resolve(at)
        reads.set(full, read || reads.get(full) === true)
      }
      return Reflect.apply(original, this, args)
    }
  const originals = [...READS, ...LOOKS].map((name) => [name, fs[name]])
  for (const [name, original] of originals) fs[name] = wrap(original, READS.includes(name))
  try {
    load()
  } finally {
    reading = false
    for (const [name, original] of originals) fs[name] = original
  }
  return reads
}

// The lockfiles of the first directory up from `dir` that has any.
function lockfilesOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const found = LOCKFILES.map((name) => join(at, name)).filter((path) => existsSync(path))
    if (found.length > 0 || dirname(at) === at) return found
  }
}

// The package.json of the node_modules package `path` is in; null for the project's own files.
const manifestOf = (path) => {
  const found = path.lastIndexOf(NODE_MODULES)
  if (found === -1) return null
  const at = found + NODE_MODULES.length
  const [scope, name] = path.slice(at).split(sep)
  return join(path.slice(0, at), scope.startsWith('@') ? join(scope, name ?? '') : scope, 'package.json')
}
// The package.json of package `name` as Node finds it from `dir`, or null.
const dependencyOf = (dir, name) => {
  for (let at = dir; ; at = dirname(at)) {
    const path = join(at, 'node_modules', name, 'package.json')
    if (existsSync(path)) return path
    if (dirname(at) === at) return null
  }
}

// `modules`, plus the package.json of each package they are in and, transitively, of their dependencies
// (optional and peer too), which Babel and plugins may load lazily (@babel/helpers). Each by the path
// found and its real path (pnpm); with `from`, also where Node finds each module's package from there.
export function withDependencies(modules, from = null) {
  const found = new Set()
  const real = new Set()
  const add = (path) => {
    if (path === null || found.has(path)) return
    found.add(path)
    try {
      const resolved = realpathSync(path)
      found.add(resolved)
      real.add(resolved)
    } catch {
      // None there.
    }
  }
  for (const path of modules) add(manifestOf(path))
  const loaded = new Set(real)
  for (const path of real) {
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (from !== null && loaded.has(path) && typeof manifest?.name === 'string') add(dependencyOf(from, manifest.name))
    for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies, ...manifest?.peerDependencies })) add(dependencyOf(dirname(path), name))
  }
  return [...new Set([...modules, ...found])]
}

// The reads of paths other than `modules`, whose code is digested anyway.
const othersOf = (reads, modules) => {
  const loaded = new Set(modules)
  return [...reads].filter(([path]) => !loaded.has(path))
}

// What a Babel worker's output depends on besides each file's own config and source: its options, the
// code of `modules`, the state of each other path its config read or looked for (readsOf()), NODE_ENV
// and BABEL_ENV, and, where a module can't be read (a Yarn Plug'n'Play zip's), the lockfiles.
export function fingerprintOf(modules, options, reads = []) {
  return digest(JSON.stringify([
    options,
    envOf(),
    modules.toSorted().map((path) => [path, fileDigest(path)]),
    othersOf(reads, modules).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([path, read]) => [path, stateOf(path, read)]),
    fallbackOf(modules.map(statOf), options),
  ]))
}

// The lockfiles' digests (from options.cwd) if some module can't be stat'ed (a zip's); else null.
const fallbackOf = (stats, options) => (stats.some((stat) => stat === null) ? lockfilesOf(options?.cwd ?? process.cwd()).map((path) => [path, fileDigest(path)]) : null)

// A digest of the code of the module at `path` and of the project's own modules it requires,
// transitively, per `modules` (require.cache): once a run, so later transforms' requires don't change it.
function codeOf(modules) {
  const known = new Map()
  return (path) =>
    memo(known, path, () => {
      const reached = new Set([path])
      for (const each of reached) if (!each.includes(NODE_MODULES)) for (const child of modules[each]?.children ?? []) reached.add(child.filename)
      return digest(JSON.stringify([...reached].toSorted().map((each) => [each, fileDigest(each)])))
    })
}

// The absolute paths `run` requires through Module's require (as a plugin's factory does), loaded or not.
function requiresOf(run) {
  const required = new Set()
  const { require } = Module.prototype
  Module.prototype.require = function (id) {
    try {
      const path = Module._resolveFilename(id, this)
      if (isAbsolute(path)) required.add(path)
    } catch {
      // Not found: the require fails as it would.
    }
    return Reflect.apply(require, this, [id])
  }
  try {
    run()
  } finally {
    Module.prototype.require = require
  }
  return [...required].toSorted()
}

// Babel looks for each config file (and package.json) of each directory again for each file, by
// existsSync then statSync: 60k syscalls for an app of 10k files. run() answers each once a build.
function lookingOnce() {
  const looked = new Map()
  const once = (kind, path, look) => {
    const { value, error } = memo(looked, `${kind}\0${path}`, () => {
      try {
        return { value: look() }
      } catch (thrown) {
        return { error: thrown }
      }
    })
    if (error !== undefined) throw error
    return value
  }
  const run = (load) => {
    const { existsSync: exists, statSync: stat } = fs
    fs.existsSync = (path) => once('exists', path, () => exists(path))
    fs.statSync = (path, statOptions) => (statOptions === undefined ? once('stat', path, () => stat(path)) : stat(path, statOptions))
    try {
      return load()
    } finally {
      fs.existsSync = exists
      fs.statSync = stat
    }
  }
  return { run, clear: () => looked.clear() }
}

// Returns (filename, covered) => a key of the Babel config `core` loads for the file: its options, the
// code of its config files and plugins (except `covered`), and what the factories of plugins the root
// config lacks require. null if Babel ignores the file or fails. Call start() as each build starts.
export function configKeyOf(core, options, modules) {
  const code = codeOf(modules)
  // Each options object is digested once a run, as Babel reuses it across files: a big alias map took 1 ms a key.
  const digests = new WeakMap()
  const optionsOf = (given) => (typeof given !== 'object' || given === null ? [given ?? null] : memo(digests, given, () => digest(JSON.stringify(given, shown))))
  const itemOf = (item) => [item.name ?? null, item.file?.resolved ?? null, optionsOf(item.options)]
  const instanceOf = (item) => JSON.stringify(itemOf(item))
  const itemsOf = ({ plugins, presets }) => [...plugins.map((item) => [item, 'plugin']), ...presets.map((item) => [item, 'preset'])]
  const createItem = core.createConfigItemSync ?? core.createConfigItem
  // The root config's items: the workers' fingerprint covers what their factories require.
  let rooted = null
  const rootedOf = () => {
    try {
      rooted ??= new Set(itemsOf(core.loadPartialConfigSync({ ...options, filename: join(options.cwd ?? process.cwd(), 'index.js') }).options).map(([item]) => instanceOf(item)))
    } catch {
      rooted = new Set()
    }
    return rooted
  }
  // loadPartialConfig() runs no factories, so each other item is built alone, once a run, to see what it requires.
  const made = new Map()
  const requiredOf = (item, type) =>
    memo(made, instanceOf(item), () => {
      const own = createItem(item.options === undefined ? item.value : [item.value, item.options], { dirname: item.dirname, type })
      const { cwd, root, caller, envName } = options
      return requiresOf(() => core.loadOptionsSync({ cwd, root, caller, envName, babelrc: false, configFile: false, [`${type}s`]: [own] })).map((path) => [path, code(path)])
    })
  const looking = lookingOnce()
  const keyOf = (filename, covered = new Set()) => {
    try {
      const partial = looking.run(() => core.loadPartialConfigSync({ ...options, filename }))
      if (partial === null) return null
      const items = itemsOf(partial.options)
      // Digest the code before any factory runs here.
      const named = items.map(([item]) => item.file?.resolved).filter((path) => path !== undefined)
      const codes = [...partial.files, ...named].filter((path) => !covered.has(path)).map((path) => [path, code(path)])
      const required = items.filter(([item]) => !rootedOf().has(instanceOf(item))).map(([item, type]) => requiredOf(item, type))
      return digest(JSON.stringify([codes, required, { ...partial.options, plugins: partial.options.plugins.map(itemOf), presets: partial.options.presets.map(itemOf) }], shown))
    } catch {
      return null
    }
  }
  return Object.assign(keyOf, { start: looking.clear })
}

// A module's inode, size, mtime and ctime: while all match, a kept fingerprint holds without reading the
// code. Size and mtime alone aren't enough: package managers write the tarball's mtime (npm's is 1985),
// but a rewritten file gets a new inode and ctime.
const statOf = (path) => {
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(path)
    return [ino, size, mtimeMs, ctimeMs]
  } catch {
    return null
  }
}
const statesOf = ({ modules, reads, options }) => {
  const stats = modules.map(statOf)
  return JSON.stringify([stats, othersOf(reads, modules).map(([path, read]) => stateOf(path, read)), fallbackOf(stats, options)])
}
const signed = (made) => ({ ...made, signature: statesOf(made) })
const unchanged = (kept) => typeof kept.signature === 'string' && statesOf(kept) === kept.signature

// The cache in `dir`: (target) => its store (load-store.js), plus settled() for pending pack writes.
// Keys are salted with the format, rn's code, esbuild's version and flow-remove-types'; a target's
// fingerprint is kept with its stats, so a later run reuses it without starting a worker for it.
export function createLoadCache(dir, { esbuild, flow = null }) {
  const salt = digest(JSON.stringify([CACHE_FORMAT, ownModules().map(fileDigest), esbuild.version, flow === null ? null : withDependencies([flow]).map((path) => [path, fileDigest(path)])]))
  // Other salts' entries are never read again: load-prune.js removes them once unused.
  const entries = join(dir, 'entries', salt)
  touch(entries)
  const read = (key) => readEntry(entries, key)
  const write = (key, value) => writeEntry(entries, key, value)
  // The kept fingerprint if its stats or its digest still match, else a new one from the workers; null if none.
  const fingerprintFor = async (babel) => {
    const key = digest(JSON.stringify([salt, 'fingerprint', babel.workerOptions, ...envOf()]))
    const kept = read(key)
    try {
      if (kept !== null && unchanged(kept)) return kept
      if (kept !== null && fingerprintOf(kept.modules, kept.options, kept.reads) === kept.fingerprint) {
        write(key, signed(kept))
        return kept
      }
    } catch {}
    try {
      const made = await babel.fingerprint()
      write(key, signed(made))
      return made
    } catch {
      return null
    }
  }
  // A target's key prefix (from its fingerprint) and the modules the fingerprint covers; null without one.
  const bases = new WeakMap()
  const baseOf = (babel) => {
    if (babel === null) return Promise.resolve({ prefix: salt, covered: null })
    return memo(bases, babel, () => fingerprintFor(babel).then((made) => (made === null ? null : { prefix: `${salt}\0${made.fingerprint}`, covered: new Set(made.modules) })))
  }
  // A pack per worker options and key prefix, so a config change starts a new pack.
  const packs = new Map()
  const packOf = async (babel) => {
    const name = digest(JSON.stringify([salt, babel?.workerOptions ?? null, (await baseOf(babel))?.prefix ?? null]))
    return memo(packs, name, () => createPack(join(dir, 'packs', name)))
  }
  // Pack writes in progress; a failed one only loses what it would have cached.
  const writing = new Set()
  const track = (pending) => {
    const written = pending.catch(() => {})
    writing.add(written)
    void written.finally(() => writing.delete(written))
    return written
  }
  const storeFor = (babel) => storeOf(babel, { salt, packed: () => packOf(babel), base: () => baseOf(babel), read, write, track })
  return Object.assign(storeFor, { settled: () => Promise.all(writing) })
}
