// rn-serve's on-disk cache of each file as loadFile() (load.js) loads it, keyed by all its output
// depends on: the file, rn's own code, esbuild and flow-remove-types, the project's Babel config and
// what it loads or reads, and the loadFile() options that change it (--esm's among them).

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs, { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { Module } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPack, pause, readEntry, touch, writeEntry } from './load-pack.js'

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
const attempt = (run) => {
  try {
    return run()
  } catch {
    return null
  }
}
const envOf = () => [process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null]
const fileDigest = (path) => attempt(() => digest(readFileSync(path)))
// A JSON replacer that keeps functions and RegExps by their source.
const shown = (_, value) => (typeof value === 'function' || value instanceof RegExp ? String(value) : value)
// Runs `run` with each of `object`'s methods `names` as `wrap(original, name)` makes it, then puts them back.
function patched(object, names, wrap, run) {
  const originals = Object.fromEntries(names.map((name) => [name, object[name]]))
  for (const name of names) object[name] = wrap(originals[name], name)
  try {
    return run()
  } finally {
    Object.assign(object, originals)
  }
}

// The CHAIN modules and every rn module they import, transitively, as those shape the output too
// (worklets.js's Reanimated gate shapes Babel's, for one).
export function ownModules() {
  const paths = new Set(CHAIN.map((name) => join(import.meta.dirname, name)))
  for (const path of paths) for (const [, specifier] of readFileSync(path, 'utf8').matchAll(RELATIVE)) paths.add(join(dirname(path), specifier))
  return [...paths].toSorted()
}

// Runs `load` (Babel's first load of a config) and returns Map<path, whether read> of the paths it read
// or only checked for through the node:fs object. A function a config keeps from it
// (`const { readFileSync } = require('node:fs')`) stops recording once `load` is done.
export function readsOf(load) {
  const reads = new Map()
  let reading = true
  const note = (given, read) => {
    const path = given instanceof URL && given.protocol === 'file:' ? fileURLToPath(given) : given
    // Not a file descriptor, nor a URL of another scheme.
    if (typeof path !== 'string' && !Buffer.isBuffer(path)) return
    const full = resolve(String(path))
    reads.set(full, read || reads.get(full) === true)
  }
  const wrap = (original, name) => (path, ...rest) => {
    if (reading) note(path, READS.includes(name))
    return original(path, ...rest)
  }
  patched(fs, [...READS, ...LOOKS], wrap, load)
  reading = false
  return reads
}

// The package.json of the node_modules package `path` is in; null for the project's own files.
const manifestOf = (path) => {
  const parts = path.split(sep)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1) return null
  return [...parts.slice(0, parts[at + 1]?.startsWith('@') ? at + 3 : at + 2), 'package.json'].join(sep)
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
  // Each manifest to read, by its real path: whether it is a module's own package's.
  const manifests = new Map()
  const add = (path, own = false) => {
    if (path === null || found.has(path)) return
    found.add(path)
    const real = attempt(() => realpathSync(path))
    if (real === null || manifests.has(real)) return
    found.add(real)
    manifests.set(real, own)
  }
  for (const path of modules) add(manifestOf(path), true)
  for (const [path, own] of manifests) {
    const manifest = attempt(() => JSON.parse(readFileSync(path, 'utf8')))
    if (own && from !== null && typeof manifest?.name === 'string') add(dependencyOf(from, manifest.name))
    for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies, ...manifest?.peerDependencies })) add(dependencyOf(dirname(path), name))
  }
  return [...new Set([...modules, ...found])]
}

// What a Babel worker's output depends on besides each file's own config and source: its options, the
// code of `modules`, the state of each other path its config read or looked for (readsOf()), NODE_ENV
// and BABEL_ENV, and, where a module can't be read (a Yarn Plug'n'Play zip's), the lockfiles.
export const fingerprintOf = (modules, options, reads = []) => digest(JSON.stringify(inputsOf(modules, options, reads, fileDigest)))

// A module's inode, size, mtime and ctime: while all match, a kept fingerprint holds without reading the
// code. Size and mtime alone aren't enough: package managers write the tarball's mtime (npm's is 1985),
// but a rewritten file gets a new inode and ctime.
const statOf = (path) =>
  attempt(() => {
    const { ino, size, mtimeMs, ctimeMs } = statSync(path)
    return [ino, size, mtimeMs, ctimeMs]
  })
const signatureOf = ({ modules, options, reads }) => JSON.stringify(inputsOf(modules, options, reads, statOf))

// A path's state: if `read`, a file's digest or a directory's entries; else just 'file' or 'directory'
// (Babel and browserslist look for their configs up to the root). null if missing.
const stateOf = (path, read) =>
  attempt(() => {
    const directory = statSync(path).isDirectory()
    if (!read) return directory ? 'directory' : 'file'
    return directory ? readdirSync(path).toSorted() : digest(readFileSync(path))
  })

// fingerprintOf()'s inputs, with each module as `look` has it: its digest, or its stats.
function inputsOf(modules, options, reads, look) {
  const own = new Set(modules)
  const looked = [...own].toSorted().map((path) => [path, look(path)])
  const others = [...reads].filter(([path]) => !own.has(path)).map(([path, read]) => [path, stateOf(path, read)])
  const fallback = looked.some(([, value]) => value === null) ? lockfilesOf(options.cwd ?? process.cwd()) : null
  return [options, envOf(), looked, others.toSorted(([a], [b]) => (a < b ? -1 : 1)), fallback]
}

// The digests of the lockfiles of the first directory up from `dir` that has any.
function lockfilesOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const found = LOCKFILES.map((name) => join(at, name)).filter((path) => existsSync(path))
    if (found.length > 0 || dirname(at) === at) return found.map((path) => [path, fileDigest(path)])
  }
}

// The absolute paths `run` requires through Module's require (as a plugin's factory does), loaded or not.
function requiresOf(run) {
  const required = new Set()
  const wrap = (require) =>
    function (id) {
      // Not found, the require fails as it would.
      const path = attempt(() => Module._resolveFilename(id, this))
      if (path !== null && isAbsolute(path)) required.add(path)
      return require.call(this, id)
    }
  patched(Module.prototype, ['require'], wrap, run)
  return [...required].toSorted()
}

// Babel looks for each config file (and package.json) of each directory again for each file, by
// existsSync then statSync: 60k syscalls for an app of 10k files. Runs `load` with each answered once a
// build, from `looked`; a stat that throws is asked again.
function lookingOnce(looked, load) {
  const wrap = (original, name) => (path, statOptions) => (statOptions === undefined ? memo(looked, `${name}\0${path}`, () => original(path)) : original(path, statOptions))
  return patched(fs, ['existsSync', 'statSync'], wrap, load)
}

// Returns (filename, covered) => a key of the Babel config `core` loads for the file: its options, the
// code of its config files and plugins (except `covered`), and what the factories of plugins the root
// config lacks require. null if Babel ignores the file or fails. Call start() as each build starts.
export function configKeyOf(core, options, modules) {
  const { cwd = process.cwd(), root, caller, envName } = options
  // A digest of the code of the module at `path` and of the project's own modules it requires,
  // transitively, per `modules` (require.cache): once a run, so later transforms' requires don't change it.
  const codes = new Map()
  const code = (path) =>
    memo(codes, path, () => {
      const reached = new Set([path])
      for (const each of reached) if (!each.includes(NODE_MODULES)) for (const child of modules[each]?.children ?? []) reached.add(child.filename)
      return digest(JSON.stringify([...reached].toSorted().map((each) => [each, fileDigest(each)])))
    })
  // Each item of a config's, with its id: its type, name, file and options, digested once a run, as Babel
  // reuses them across files: a big alias map took 1 ms a key.
  const digests = new WeakMap()
  const itemsOf = (config) =>
    ['plugin', 'preset'].flatMap((type) =>
      config[`${type}s`].map((item) => {
        const given = typeof item.options === 'object' && item.options !== null ? memo(digests, item.options, () => digest(JSON.stringify(item.options, shown))) : item.options
        return { item, type, id: JSON.stringify([type, item.name, item.file?.resolved, given]) }
      }),
    )
  // The root config's items: the workers' fingerprint covers what their factories require.
  const rooted = new Set(attempt(() => itemsOf(core.loadPartialConfigSync({ ...options, filename: join(cwd, 'index.js') }).options).map(({ id }) => id)))
  // loadPartialConfig() runs no factories, so each other item is built alone, once a run, to see what it requires.
  const createItem = core.createConfigItemSync ?? core.createConfigItem
  const required = new Map()
  const requiredOf = ({ item, type, id }) =>
    memo(required, id, () => {
      const own = createItem(item.options === undefined ? item.value : [item.value, item.options], { dirname: item.dirname, type })
      return requiresOf(() => core.loadOptionsSync({ cwd, root, caller, envName, babelrc: false, configFile: false, [`${type}s`]: [own] })).map((path) => [path, code(path)])
    })
  const looked = new Map()
  const keyOf = (filename, covered = new Set()) =>
    attempt(() => {
      const partial = lookingOnce(looked, () => core.loadPartialConfigSync({ ...options, filename }))
      if (partial === null) return null
      const items = itemsOf(partial.options)
      // Digest the code before any factory runs here.
      const files = [...partial.files, ...items.map(({ item }) => item.file?.resolved)].filter((path) => path !== undefined && !covered.has(path)).map((path) => [path, code(path)])
      const factories = items.filter(({ id }) => !rooted.has(id)).map(requiredOf)
      return digest(JSON.stringify([files, factories, items.map(({ id }) => id), { ...partial.options, plugins: undefined, presets: undefined }], shown))
    })
  return Object.assign(keyOf, { start: () => looked.clear() })
}

// The cache in `dir`: (target) => its store, plus settled() for pending pack writes. Keys are salted
// with rn's code, esbuild's version and flow-remove-types'; a target's fingerprint is kept with its
// stats, so a later run reuses it without starting a worker for it.
export function createLoadCache(dir, { esbuild, flow = null }) {
  const salt = digest(JSON.stringify([ownModules().map(fileDigest), esbuild.version, flow === null ? null : withDependencies([flow]).map((path) => [path, fileDigest(path)])]))
  // Other salts' entries are never read again: load-prune.js removes them once unused.
  const entries = join(dir, 'entries', salt)
  touch(entries)
  // Per target, asked for at its first use: its key prefix and the modules its fingerprint covers
  // (null without one), and its pack, named by the prefix, so a config change starts a new pack.
  const targets = new Map()
  const targetOf = (babel) =>
    memo(targets, babel, () => {
      const base = babel === null ? Promise.resolve({ prefix: salt, covered: null }) : fingerprintFor(babel, entries).then((made) => (made === null ? null : { prefix: `${salt}\0${made.fingerprint}`, covered: new Set(made.modules) }))
      return { base, pack: base.then((made) => createPack(join(dir, 'packs', digest(made?.prefix ?? salt)))) }
    })
  // Pack writes in progress; a failed one only loses what it would have cached.
  let writes = Promise.resolve()
  const track = (pending) => {
    const written = pending.catch(() => {})
    writes = Promise.all([writes, written])
    return written
  }
  const storeFor = (babel) => storeOf(babel, () => targetOf(babel), { salt, entries, track })
  return Object.assign(storeFor, { settled: () => writes })
}

// The kept fingerprint if its stats or its digest still match, else a new one from the workers; null if none.
async function fingerprintFor(babel, entries) {
  const key = digest(JSON.stringify(['fingerprint', babel.workerOptions, envOf()]))
  const kept = readEntry(entries, key)
  const signed = (made) => {
    writeEntry(entries, key, { ...made, signature: signatureOf(made) })
    return made
  }
  if (kept !== null && kept.signature === signatureOf(kept)) return kept
  if (kept !== null && fingerprintOf(kept.modules, kept.options, kept.reads) === kept.fingerprint) return signed(kept)
  try {
    return signed(await babel.fingerprint())
  } catch {
    return null
  }
}

const hashOf = (head, parts, text) => createHash('sha256').update(`${head}\0${JSON.stringify(parts)}\0`).update(text).digest('hex')
const newTally = () => ({ hits: 0, misses: 0, memory: 0, unkept: {}, ms: 0 })

// A target's store: its keys, its pack, and a tally per build.
function storeOf(babel, target, { salt, entries, track }) {
  let tally = newTally()
  // Counts the time run() takes as the cache's.
  const timed = (run) => {
    const start = performance.now()
    try {
      return run()
    } finally {
      tally.ms += performance.now() - start
    }
  }
  // The pack, read once, at the first get() or build(), its time counted as the cache's.
  let pack = null
  let reading = null
  const read = async () => {
    const made = await target().pack
    const start = performance.now()
    await made.load()
    tally.ms += performance.now() - start
    pack = made
  }
  // The value kept under `key`, or null; after a hit, the event loop gets its turn where due.
  const take = async (key) => {
    await (reading ??= read())
    const kept = timed(() => pack.get(key))
    if (kept !== null) await pause()
    return kept
  }
  const set = (key, value) => timed(() => pack.set(key, value))
  const keyOf = async (path, contents, variant) => {
    const base = await target().base
    if (base === null) return { key: null, why: 'fingerprint' }
    const config = babel === null ? '' : timed(() => babel.configKey(path, base.covered))
    if (config === null) return { key: null, why: 'config' }
    return { key: timed(() => hashOf(base.prefix, [path, variant, config], contents)) }
  }
  return {
    keyOf,
    get: async (key) => {
      const result = await take(key)
      if (result !== null) tally.hits++
      return result
    },
    set,
    // A dev module's build, by its parts and source alone: no Babel config is involved.
    build: async (parts, text, compute) => {
      const key = timed(() => hashOf(`${salt}\0module`, parts, text))
      const kept = await take(key)
      if (kept !== null) return kept
      const value = await compute()
      set(key, value)
      return value
    },
    // A value compute() derives from the file's config, kept as a loose entry under `kind`.
    keep: async (kind, path, compute) => {
      const { key } = await keyOf(path, '', [kind])
      const kept = key === null ? null : readEntry(entries, key)
      if (kept !== null) return kept
      const value = await compute()
      if (key !== null) writeEntry(entries, key, value)
      return value
    },
    // Counts a file as `memory`, `misses` or `unkept` (with `why`); get() counts `hits`.
    note: (what, why = null) => {
      if (what === 'unkept') tally.unkept[why] = (tally.unkept[why] ?? 0) + 1
      else tally[what]++
    },
    start: () => {
      tally = newTally()
      babel?.configStart()
      void target().pack.then((made) => made.start())
    },
    // The build's tally, and a promise of its pack written.
    finish: () => {
      const was = tally
      tally = newTally()
      return { tally: was, written: track(target().pack.then((made) => made.finish())) }
    },
  }
}
