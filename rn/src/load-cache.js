// Each file as esbuild loads it (load.js's loadFile()), on disk, across
// runs (rn-serve's): its Flow stripped, lowered by esbuild, and the project's
// Babel config's output, each file's by a key of all it is of, so that none
// is taken where they would make another: of a change to the file, to rn's
// code, to esbuild or flow-remove-types, to the project's Babel config, to
// what it loads or reads, or to the plugins left out of it (--esm's).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Module } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// A cache entry's format: another, none of the entries before.
const CACHE_FORMAT = 2
// rn's code of the chain: loadFile()'s, Babel's worker's, and this file's.
const OWN = ['load.js', 'babel-worker.js', 'load-cache.js'].map((name) => join(import.meta.dirname, name))
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
// node:fs's sync calls a config may read a file by, and those it may look
// for one by, as Babel loads it: Babel loads a config sync.
const READS = ['readFileSync', 'readdirSync']
const LOOKS = ['existsSync', 'statSync', 'lstatSync', 'accessSync']
const digest = (data) => createHash('sha256').update(data).digest('hex')
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

// What a Babel worker's output is of, but a file's own config (configKeyOf())
// and its source: the options the worker was given, each of `modules`,
// those it has loaded once its config is (@babel/core, the config, its
// plugins and presets, and what they require, the project's or a
// package's), by its code; each other path of `reads`, those the config
// read or looked for as it loaded (readsOf()), as it is (stateOf());
// NODE_ENV and BABEL_ENV, which plugins read.
export function fingerprintOf(modules, options, reads = new Map()) {
  const loaded = new Set(modules)
  return digest(JSON.stringify([
    options,
    [process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null],
    modules.toSorted().map((path) => [path, fileDigest(path)]),
    [...reads].filter(([path]) => !loaded.has(path)).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([path, read]) => [path, stateOf(path, read)]),
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
// to be made, or its options are no JSON.
export function configKeyOf(core, options, modules) {
  const code = codeOf(modules)
  const itemOf = (item) => [item.name ?? null, item.file?.resolved ?? null, item.options ?? null]
  const instanceOf = (item) => JSON.stringify(itemOf(item), shown)
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
  return (filename, covered = new Set()) => {
    try {
      const partial = core.loadPartialConfigSync({ ...options, filename })
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
}

// What is kept in `dir` by a key: JSON, or null where none.
const entryPath = (dir, key) => join(dir, key.slice(0, 2), key.slice(2))
function readEntry(dir, key) {
  try {
    return JSON.parse(readFileSync(entryPath(dir, key), 'utf8'))
  } catch {
    return null
  }
}

// Written whole, then moved in place: another rn-serve may read it.
function writeEntry(dir, key, value) {
  const path = entryPath(dir, key)
  const written = `${path}.${process.pid}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(written, JSON.stringify(value))
    renameSync(written, path)
  } catch {
    // Nor what is left of it, where it can't be: the file is loaded still.
    try {
      rmSync(written, { force: true })
    } catch {}
  }
}

// Each file as loadFile() loads it, kept in `dir`, by a key of what it is
// of: rn's code of the chain (OWN), esbuild's version, flow-remove-types
// (`flow`, its path, or null) by its code, the project's lockfile, of the
// versions of what they load (from `cwd`); a target's Babel (projectBabel()'s,
// or null), its workers' fingerprint (fingerprintOf()) and the file's own
// config (configKeyOf()); the file's path, its contents, and `variant`, what
// of loadFile()'s options make it (its sourcemap, esm, keepPlugins). A
// target's fingerprint is kept with what it is a digest of: a run after,
// where those are the same, it is that, at once, before its workers load
// Babel and the config. -> (babel) => { keyOf(path, contents, variant)
// (async, null where none is kept), get(key) (loadFile()'s result, or null
// where none), set(key, result), keep(kind, path, compute) (async: what
// compute() gives, of the file's config, kept as `kind`, JSON), tally() },
// of a target; tally() -> { taken, made } since it was last asked, of the
// results taken and set. Each is written whole, then moved in place:
// another rn-serve may read it. A cache, at best: what fails to read or
// write is loaded anew.
export function createLoadCache(dir, { esbuild, flow = null, cwd }) {
  const salt = digest(JSON.stringify([CACHE_FORMAT, OWN.map(fileDigest), esbuild.version, flow === null ? null : [flow, fileDigest(flow)], lockfilesOf(cwd).map((path) => [path, fileDigest(path)])]))
  const read = (key) => readEntry(dir, key)
  const write = (key, value) => writeEntry(dir, key, value)
  // A target's fingerprint, and what it is a digest of: the one kept, where
  // that is the same; else its workers', kept. null where none.
  const fingerprintFor = async (babel) => {
    const key = digest(JSON.stringify([salt, 'fingerprint', babel.workerOptions]))
    const kept = read(key)
    try {
      if (kept !== null && fingerprintOf(kept.modules, kept.options, new Map(kept.reads)) === kept.fingerprint) return kept
    } catch {}
    try {
      const made = await babel.fingerprint()
      write(key, made)
      return made
    } catch {
      return null
    }
  }
  // -> { prefix, covered }: of a target, its keys' prefix, and the modules
  // its fingerprint is of; null where it has none.
  const bases = new WeakMap()
  const baseOf = (babel) => {
    if (babel === null) return Promise.resolve({ prefix: salt, covered: null })
    if (!bases.has(babel)) bases.set(babel, fingerprintFor(babel).then((made) => (made === null ? null : { prefix: `${salt}\0${made.fingerprint}`, covered: new Set(made.modules) })))
    return bases.get(babel)
  }
  return (babel) => {
    const keyOf = async (path, contents, variant) => {
      const base = await baseOf(babel)
      if (base === null) return null
      const { prefix, covered } = base
      const config = babel === null ? '' : babel.configKey(path, covered)
      if (config === null) return null
      return createHash('sha256').update(prefix).update('\0').update(JSON.stringify([path, variant, config])).update('\0').update(contents).digest('hex')
    }
    let tally = { taken: 0, made: 0 }
    return {
      keyOf,
      get: (key) => {
        const result = read(key)
        if (typeof result?.contents !== 'string' || typeof result.loader !== 'string') return null
        tally.taken++
        return result
      },
      set: (key, result) => {
        write(key, result)
        tally.made++
      },
      keep: async (kind, path, compute) => {
        const key = await keyOf(path, '', [kind])
        const kept = key === null ? null : read(key)
        if (kept !== null && Object.hasOwn(kept, 'value')) return kept.value
        const value = await compute()
        if (key !== null) write(key, { value })
        return value
      },
      tally: () => {
        const was = tally
        tally = { taken: 0, made: 0 }
        return was
      },
    }
  }
}
