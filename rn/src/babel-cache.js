// Babel's output on disk, across runs (rn-serve's), as Babel's workers
// keep it: each file's by a key of all it is of, so that none is taken where
// Babel would make another, of a change to the source, to the project's
// Babel config, to what it loads, or to the plugins left out of it.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { threadId } from 'node:worker_threads'

// A cache entry's format: another, none of the entries before.
const CACHE_FORMAT = 1
// rn's code of the transform: this file's, and the worker's.
const OWN = [import.meta.filename, join(import.meta.dirname, 'babel-worker.js')]
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
const digest = (data) => createHash('sha256').update(data).digest('hex')
const fileDigest = (path) => {
  try {
    return digest(readFileSync(path))
  } catch {
    return null
  }
}

// The project's lockfiles: those of the first directory, up from `dir`, that has one.
function lockfilesOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const found = LOCKFILES.map((name) => join(at, name)).filter((path) => existsSync(path))
    if (found.length > 0 || dirname(at) === at) return found
  }
}

// What a worker's output is of, but the options it transforms a file with
// and its source: rn's code of it, the options the worker was given, and
// each of `modules`, those it has loaded once its config is (@babel/core,
// the config, its plugins and presets, and what they require, the
// project's or a package's), by its code; the project's lockfile, of the
// versions of what Babel loads as it transforms (its parser, its
// generator); NODE_ENV and BABEL_ENV, which plugins read.
export function fingerprintOf(modules, options, cwd) {
  return digest(JSON.stringify([
    CACHE_FORMAT,
    OWN.map(fileDigest),
    options,
    [process.env.NODE_ENV ?? null, process.env.BABEL_ENV ?? null],
    modules.toSorted().map((path) => [path, fileDigest(path)]),
    lockfilesOf(cwd).map((path) => [path, fileDigest(path)]),
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

// Babel's output kept in `dir`, each { code, imports } by a key of what it
// is of: the fingerprint (fingerprintOf()); the options transformSync takes
// for the file (the config's, as Babel loads them for it, the file's name
// among them, but the plugins left out of them, and those added), each
// plugin by its key and options; the code of the config's files Babel loads
// for the file (a .babelrc of its directory too) and of the plugins and
// presets they name for it (an override's too, which the fingerprint, of
// the config of the project's root, may not have), as `partial`, Babel's
// loadPartialConfig() of the file, has them, and what they require of the
// project's own (codeOf(), `modules` require.cache); and the source. Of a
// change to the config, to what it requires or reads, or to the plugins it
// leaves out (--esm's), another key. -> { keyOf(options, source, partial)
// (null where Babel ignores the file, or its options are no JSON), get(key)
// (null where none), set(key, entry) }. Each entry is written whole, then
// moved in place: another rn-serve may read it. A cache, at best: what
// fails to read or write is a transform.
export function cacheOf(dir, fingerprint, modules) {
  const pathOf = (key) => join(dir, key.slice(0, 2), key.slice(2))
  const code = codeOf(modules)
  // A function and a RegExp by their code, which JSON leaves out.
  const shown = (_, value) => (typeof value === 'function' || value instanceof RegExp ? String(value) : value)
  return {
    keyOf: (options, source, partial) => {
      if (partial === null) return null
      try {
        const named = [...partial.options.plugins, ...partial.options.presets].map((item) => item.file?.resolved).filter((path) => path !== undefined)
        const config = JSON.stringify([[...partial.files, ...named].map(code), { ...options, plugins: options.plugins.map(({ key, options: of }) => [key, of ?? null]) }], shown)
        return createHash('sha256').update(fingerprint).update('\0').update(config).update('\0').update(source).digest('hex')
      } catch {
        return null
      }
    },
    get: (key) => {
      try {
        const entry = JSON.parse(readFileSync(pathOf(key), 'utf8'))
        return typeof entry?.code === 'string' && Array.isArray(entry.imports) ? entry : null
      } catch {
        return null
      }
    },
    set: (key, entry) => {
      const path = pathOf(key)
      const written = `${path}.${process.pid}-${threadId}`
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(written, JSON.stringify(entry))
        renameSync(written, path)
      } catch {
        rmSync(written, { force: true })
      }
    },
  }
}
