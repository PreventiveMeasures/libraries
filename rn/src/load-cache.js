// Each file as esbuild loads it (load.js's loadFile()), on disk, across
// runs (rn-serve's): its Flow stripped, lowered by esbuild, and the project's
// Babel config's output, each file's by a key of all it is of, so that none
// is taken where they would make another: of a change to the file, to rn's
// code, to esbuild or flow-remove-types, to the project's Babel config, to
// what it loads or reads, or to the plugins left out of it (--esm's).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs, { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { Module } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPack, readEntry, touch, writeEntry } from './load-pack.js'
import { storeOf } from './load-store.js'

// A cache entry's format: another, none of the entries before.
const CACHE_FORMAT = 5
// rn's code of the chain: loadFile()'s, Babel's worker's, a dev bundle's
// module's build (modules.js), and this file's.
const CHAIN = ['load.js', 'babel-worker.js', 'modules.js', 'load-cache.js']
// A module's import or export of one of rn's, by its relative path.
const RELATIVE = /^(?:import|export)\b[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gmu
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
// node:fs's sync calls a config may read a file by, and those it may look
// for one by, as Babel loads it: Babel loads a config sync.
const READS = ['readFileSync', 'readdirSync']
const LOOKS = ['existsSync', 'statSync', 'lstatSync', 'accessSync']
const digest = (data) => createHash('sha256').update(data).digest('hex')

// The paths of rn's code of the chain (CHAIN), and of each of rn's modules
// it imports, theirs too: each of which makes what the cache keeps, as
// Reanimated's gate (worklets.js) does Babel's output.
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
// A function and a RegExp by their code, which JSON leaves out.
const shown = (_, value) => (typeof value === 'function' || value instanceof RegExp ? String(value) : value)

// A path as it is now: one a config read, a file by its digest, a
// directory by its entries; one it looked for, whether it is a file or a
// directory (Babel and browserslist look for theirs up to the root); null
// where none is there.
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

// -> Map<path, whether read>: the paths `load` reads (READS) or looks for
// (LOOKS) by node:fs's sync calls, as it runs: a config's, as Babel first
// loads it, which may keep what it reads in a function of its options,
// which the key has by its code alone. Through node:fs's own object, as a
// config requires it; a call kept from it (`const { readFileSync } =
// require('node:fs')`) is node:fs's again, once `load` is done.
export function readsOf(load) {
  const reads = new Map()
  let reading = true
  const pathOf = (path) => (typeof path === 'string' ? path : path instanceof URL && path.protocol === 'file:' ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : null)
  const wrap = (original, read) =>
    function (path, ...rest) {
      const at = reading ? pathOf(path) : null
      if (at !== null) reads.set(resolve(at), read || reads.get(resolve(at)) === true)
      return Reflect.apply(original, this, [path, ...rest])
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

// The project's lockfiles: those of the first directory, up from `dir`, that has one.
function lockfilesOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const found = LOCKFILES.map((name) => join(at, name)).filter((path) => existsSync(path))
    if (found.length > 0 || dirname(at) === at) return found
  }
}

const NODE_MODULES = `${sep}node_modules${sep}`
// The package.json of the package a module is of, of node_modules; null of
// the project's own.
const manifestOf = (path) => {
  const found = path.lastIndexOf(NODE_MODULES)
  if (found === -1) return null
  const at = found + NODE_MODULES.length
  const [scope, name] = path.slice(at).split(sep)
  return join(path.slice(0, at), scope.startsWith('@') ? join(scope, name ?? '') : scope, 'package.json')
}
// The package.json of a package `name`, as Node finds it from the package
// at `dir`; null where none is.
const dependencyOf = (dir, name) => {
  for (let at = dir; ; at = dirname(at)) {
    const path = join(at, 'node_modules', name, 'package.json')
    if (existsSync(path)) return path
    if (dirname(at) === at) return null
  }
}

// `modules`, and the package.json of each package one of them is of, of
// node_modules, and of each package those depend on (their dependencies,
// optional and peer too), as Node finds it, theirs too: what Babel and the
// plugins it has loaded may load as they transform, which they have not as
// the config loads (@babel/core's @babel/helpers, as it first adds a
// helper), whose version a change to them makes another. Of the project's
// lockfile, all else (the app's own packages, its tools) are of no output
// of the cache's: each file of a package the app loads is kept by its contents.
export function withDependencies(modules) {
  const manifests = new Set()
  const add = (path) => path !== null && manifests.add(path)
  for (const path of modules) add(manifestOf(path))
  for (const path of manifests) {
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies, ...manifest?.peerDependencies })) add(dependencyOf(dirname(path), name))
  }
  return [...new Set([...modules, ...manifests])]
}

// What a Babel worker's output is of, but a file's own config (configKeyOf())
// and its source: the options the worker was given, each of `modules`,
// those it has loaded once its config is (@babel/core, the config, its
// plugins and presets, and what they require, the project's or a
// package's), by its code; each other path of `reads`, those the config
// read or looked for as it loaded (readsOf()), as it is (stateOf());
// NODE_ENV and BABEL_ENV, which plugins read. Of a module of none read (of
// a zip's, Yarn's Plug'n'Play's), the project's lockfile too (of
// options.cwd's): what a change to its code is of.
export function fingerprintOf(modules, options, reads = new Map()) {
  const loaded = new Set(modules)
  const codes = modules.toSorted().map((path) => [path, fileDigest(path)])
  return digest(JSON.stringify([
    options,
    [process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null],
    codes,
    [...reads].filter(([path]) => !loaded.has(path)).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([path, read]) => [path, stateOf(path, read)]),
    codes.some(([, code]) => code === null) ? lockfilesOf(options.cwd ?? process.cwd()).map((path) => [path, fileDigest(path)]) : null,
  ]))
}

// -> (path) => the code of the module at `path`, and of what it requires
// of the project's own (outside node_modules), as `modules` (require.cache)
// has them, by each one's path and digest: once a run, as Babel first loads
// it for a file, so that a later transform's requires don't make it another.
function codeOf(modules) {
  const known = new Map()
  const inPackage = (path) => path.includes(`${sep}node_modules${sep}`)
  return (path) => {
    if (!known.has(path)) {
      const reached = new Set([path])
      for (const each of reached) if (!inPackage(each)) for (const child of modules[each]?.children ?? []) reached.add(child.filename)
      known.set(path, digest(JSON.stringify([...reached].toSorted().map((each) => [each, fileDigest(each)]))))
    }
    return known.get(path)
  }
}

// The modules `run` requires as it runs (a plugin's or a preset's factory,
// as Babel makes it), by their paths: each require through Module's, as a
// module's own require is, though the module is loaded already.
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

// -> (filename, covered) => a key of the project's Babel config for the
// file, as Babel loads it by `core` with `options` (its
// loadPartialConfig()): the options it gives the file, each plugin and
// preset by its name, file and options; the code of the config's files
// Babel loads for it (a .babelrc of its directory too) and of the plugins
// and presets they name for it, and what they require of the project's own
// (codeOf(), `modules` require.cache), but of those `covered` (a Set of the
// modules a worker's fingerprint is of); and of each plugin and preset of
// it the config of the project's root makes not, as the workers make it
// (an override's, a .babelrc's, one of options of its own), what its
// factory requires (requiresOf()), which loadPartialConfig() calls not:
// made anew, once a run, of an item of its own, which Babel has made none
// of. null where Babel ignores the file, or a plugin or preset of it fails
// to be made, or its options are no JSON. Its start(), as a build starts.
export function configKeyOf(core, options, modules) {
  const code = codeOf(modules)
  // An item's options by a digest of their JSON, of each object once a run,
  // as Babel gives each file's item of a config the same: a plugin's of
  // many entries (an alias map's) made each file's key 1 ms, as it was
  // JSON again, three times, of each file.
  const digests = new WeakMap()
  const optionsOf = (given) => {
    if (typeof given !== 'object' || given === null) return [given ?? null]
    if (!digests.has(given)) digests.set(given, digest(JSON.stringify(given, shown)))
    return digests.get(given)
  }
  const itemOf = (item) => [item.name ?? null, item.file?.resolved ?? null, optionsOf(item.options)]
  const instanceOf = (item) => JSON.stringify(itemOf(item))
  const itemsOf = ({ plugins, presets }) => [...plugins.map((item) => [item, 'plugin']), ...presets.map((item) => [item, 'preset'])]
  const fresh = core.createConfigItemSync ?? core.createConfigItem
  let rooted = null
  const rootedOf = () => {
    try {
      rooted ??= new Set(itemsOf(core.loadPartialConfigSync({ ...options, filename: join(options.cwd ?? process.cwd(), 'index.js') }).options).map(([item]) => instanceOf(item)))
    } catch {
      rooted = new Set()
    }
    return rooted
  }
  const made = new Map()
  const madeOf = (item, type) => {
    const instance = instanceOf(item)
    if (!made.has(instance)) {
      const own = fresh(item.options === undefined ? item.value : [item.value, item.options], { dirname: item.dirname, type })
      const required = requiresOf(() => core.loadOptionsSync({ cwd: options.cwd, root: options.root, caller: options.caller, envName: options.envName, babelrc: false, configFile: false, [`${type}s`]: [own] }))
      made.set(instance, required.map((path) => [path, code(path)]))
    }
    return made.get(instance)
  }
  // Of a build, Babel's look for each config file (and package.json) of a
  // directory, once, not of each file: each it looks for at each file's
  // config, as it checks its config is as it read it (existsSync, then
  // statSync of its mtime), each a syscall, 60k of an app of 10k files.
  const looked = new Map()
  const looking = (run) => {
    const { existsSync: exists, statSync: stat } = fs
    const once = (kind, path, look) => {
      const key = `${kind}\0${path}`
      if (!looked.has(key)) {
        try {
          looked.set(key, { value: look() })
        } catch (error) {
          looked.set(key, { error })
        }
      }
      const { value, error } = looked.get(key)
      if (error !== undefined) throw error
      return value
    }
    fs.existsSync = (path) => once('exists', path, () => exists(path))
    fs.statSync = (path, statOptions) => (statOptions === undefined ? once('stat', path, () => stat(path)) : stat(path, statOptions))
    try {
      return run()
    } finally {
      fs.existsSync = exists
      fs.statSync = stat
    }
  }
  const keyOf = (filename, covered = new Set()) => {
    try {
      const partial = looking(() => core.loadPartialConfigSync({ ...options, filename }))
      if (partial === null) return null
      const items = itemsOf(partial.options)
      // Their code before any of their factories runs here.
      const named = items.map(([item]) => item.file?.resolved).filter((path) => path !== undefined)
      const codes = [...partial.files, ...named].filter((path) => !covered.has(path)).map((path) => [path, code(path)])
      const required = items.filter(([item]) => !rootedOf().has(instanceOf(item))).map(([item, type]) => madeOf(item, type))
      return digest(JSON.stringify([codes, required, { ...partial.options, plugins: partial.options.plugins.map(itemOf), presets: partial.options.presets.map(itemOf) }], shown))
    } catch {
      return null
    }
  }
  // As a build starts: what Babel looked for, looked for anew.
  return Object.assign(keyOf, { start: () => looked.clear() })
}

// A module's inode, size, mtime and ctime: where each of those a
// fingerprint is of is as it was, its code is, a stat of each, not a read
// (2.3k of a react-native app's preset). Not its size and mtime alone: a
// package manager writes each file of a package of the mtime its tarball
// has (npm's, 1985's), and a package.json of another version may be of
// the same size; a file it writes is another (of an inode of its own, and
// a ctime, which none sets). And each path its config read or looked for,
// as it is (stateOf()).
const statOf = (path) => {
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(path)
    return [ino, size, mtimeMs, ctimeMs]
  } catch {
    return null
  }
}
const statesOf = ({ modules, reads }) => {
  const loaded = new Set(modules)
  return JSON.stringify([modules.map(statOf), reads.filter(([path]) => !loaded.has(path)).map(([path, read]) => stateOf(path, read))])
}
const signed = (made) => ({ ...made, signature: statesOf(made) })
const unchanged = (kept) => typeof kept.signature === 'string' && statesOf(kept) === kept.signature

// Each file as loadFile() loads it, kept in `dir`, by a key of what it is
// of: rn's code of the chain (ownModules()), esbuild's version, flow-remove-types
// (`flow`, its path, or null) by its code, and its dependencies' versions
// (withDependencies()); a target's Babel (projectBabel()'s,
// or null), its workers' fingerprint (fingerprintOf()) and the file's own
// config (configKeyOf()); the file's path, its contents, and `variant`, what
// of loadFile()'s options make it (its sourcemap, esm, keepPlugins). A
// target's fingerprint is kept with what it is a digest of: a run after,
// where those are the same, it is that, at once, with no worker made for it
// (babelWorkers()), nor one at all where its files are kept. -> (babel) =>
// { keyOf(path, contents, variant) (async: { key }, or { key: null, why }
// where none is kept: `fingerprint`, its workers have none; `config`, the
// file's config has no key), get(key)
// (loadFile()'s result, or null where none), set(key, result), keep(kind,
// path, compute) (async: what compute() gives, of the file's config, kept
// as `kind`, JSON), build(parts, text, compute) (async: what compute()
// gives, JSON, kept by a key of `parts`, JSON, and `text` alone: of no
// Babel config, as a dev bundle's module is built of its source, which is
// of it), note(what, why), start(), finish() }, of a target. note() counts
// a file `memory` (as it was in memory), `misses` (loaded anew), or
// `unkept` (loaded anew, kept none of, `why`); get() counts `hits`. A
// build's start() and finish() -> { tally: { hits, misses, memory, unkept:
// { [why]: count }, ms }, written }: what was counted of it, `ms` the time
// the cache took, and a promise of its pack written. A file's load and a
// module's build are kept in the target's pack (load-pack.js), read whole;
// the rest, each in a file of its own, of the salt's entries, written whole,
// then moved in place: another rn-serve may read it. A cache, at best: what fails to read or
// write is loaded anew. Its settled() -> a promise of each pack's write
// under way done, for a run to end once they are.
export function createLoadCache(dir, { esbuild, flow = null }) {
  const salt = digest(JSON.stringify([CACHE_FORMAT, ownModules().map(fileDigest), esbuild.version, flow === null ? null : withDependencies([flow]).map((path) => [path, fileDigest(path)])]))
  // Its entries, of the salt's: of another, none read again, as a run
  // after removes them once none uses them (load-prune.js's prune()).
  const entries = join(dir, 'entries', salt)
  touch(entries)
  const read = (key) => readEntry(entries, key)
  const write = (key, value) => writeEntry(entries, key, value)
  // A target's fingerprint, and what it is a digest of: the one kept, where
  // that is the same; else its workers', kept. null where none.
  const fingerprintFor = async (babel) => {
    const key = digest(JSON.stringify([salt, 'fingerprint', babel.workerOptions, process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null]))
    const kept = read(key)
    try {
      if (kept !== null && unchanged(kept)) return kept
      if (kept !== null && fingerprintOf(kept.modules, kept.options, new Map(kept.reads)) === kept.fingerprint) {
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
  // A target's pack, of its workers' options (or of none, of no Babel) and
  // its keys' prefix (its fingerprint, which a change to its config makes
  // another: a pack of its own, the one before read no more).
  const packs = new Map()
  const packOf = (babel, prefix) => {
    const name = digest(JSON.stringify([salt, babel?.workerOptions ?? null, prefix]))
    if (!packs.has(name)) packs.set(name, createPack(join(dir, 'packs', name)))
    return packs.get(name)
  }
  // -> { prefix, covered }: of a target, its keys' prefix, and the modules
  // its fingerprint is of; null where it has none.
  const bases = new WeakMap()
  const baseOf = (babel) => {
    if (babel === null) return Promise.resolve({ prefix: salt, covered: null })
    if (!bases.has(babel)) bases.set(babel, fingerprintFor(babel).then((made) => (made === null ? null : { prefix: `${salt}\0${made.fingerprint}`, covered: new Set(made.modules) })))
    return bases.get(babel)
  }
  // Each pack's write under way, for settled().
  const writing = new Set()
  // A pack's write that fails is a cache's: none kept, the run on.
  const track = (pending) => {
    const written = pending.catch(() => {})
    writing.add(written)
    void written.finally(() => writing.delete(written))
    return written
  }
  return Object.assign((babel) => storeOf(babel, { salt, packed: () => baseOf(babel).then((base) => packOf(babel, base?.prefix ?? null)), base: () => baseOf(babel), read, write, track }), { settled: () => Promise.all(writing) })
}
