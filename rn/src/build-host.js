// A build's view of the project, as both bundle formats (bundle.js, modules.js) have it: Metro's resolver
// over a host that notes each file it reads or looks for, for a watcher, and the assets built.

import { basename, dirname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { aliasing } from './babel-aliases.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

// The key of the empty module, which Metro resolves some imports to.
export const EMPTY = 'metro-empty'

export const posixRelative = (from, to) => relative(from, to).replaceAll('\\', '/')

// A build's state, with a resolver that reads each package.json anew through buildHost(), noting in `read`
// each file it reads; run.resolution's (resolutionOf()'s), as run.changes (a watcher's, or null) leave it.
// made(state) has it before what runs before the entry and the asset registry are found, which may fail (a
// manifest of no JSON): a build goes on with it, as with no react-native.
export function newState(run, read = new Set(), made = () => {}) {
  const { projectRoot, entry, platform, aliases } = run
  const host = buildHost(run.host, read)
  const resolveModule = run.resolution?.(run.changes ?? null, read) ?? metroResolverOf({ ...run, host })
  const graph = new Map()
  const assets = new Map()
  let registry = run.assetRegistryPath
  const state = {
    read,
    graph,
    before: run.runBeforeMain ?? [],
    // Resolves an import as Metro does, recording it in `graph`: -> the module, { kind, key }, or null where
    // nothing. pluginData's `imports`: the specifiers of the file's ES imports, which a require call Babel
    // made of one resolves as; its `aliases`: module-resolver's Babel left (load.js), else run.aliases.
    resolveImport(importer, specifier, kind, { imports = [], aliases: mapped = null } = {}) {
      const isESMImport = kind === 'import-statement' || kind === 'dynamic-import' || (kind === 'require-call' && imports.includes(specifier))
      const map = mapped === null ? aliases : aliasing(mapped)
      const resolution = resolveModule(importer, map?.(importer, specifier) ?? specifier, { platform, isESMImport })
      if (!graph.has(importer)) graph.set(importer, new Map())
      graph.get(importer).set(specifier, resolution)
      if (resolution === null) return null
      if (resolution.type === 'empty') return { kind: 'empty', key: EMPTY }
      // Metro builds an asset into the module of its lowest path.
      if (resolution.type === 'assetFiles') return { kind: 'asset', key: resolution.filePaths.toSorted()[0] }
      return { kind: 'file', key: resolution.filePath }
    },
    // An asset's module, as Metro builds it. The files it reads are noted even if that fails (an empty image).
    assetSource(path) {
      const data = assetData(path, { urlPath: posixRelative(projectRoot, path), platform, host })
      assets.set(path, data)
      return assetModule(data, registry)
    },
    assets: () => [...assets.keys()].toSorted().map((path) => assets.get(path)),
  }
  made(state)
  const reactNative = reactNativeOf(resolveModule, run.host, resolve(projectRoot, entry), platform)
  state.before = run.runBeforeMain ?? reactNative.runBeforeMain
  registry ??= reactNative.assetRegistryPath
  return state
}

// Metro's resolver over the host, seeing no file `blockList` matches, as Metro's file map has none.
export function metroResolverOf({ host, assetExts, resolver = {}, blockList = null }) {
  const seen = blockList === null ? host : { ...host, isFile: (path) => !blockList.some((pattern) => pattern.test(path)) && host.isFile(path) }
  return createMetroResolver({ ...resolver, host: seen, assetExts })
}

// The host a build looks up and reads files through, noting in `read` each it reads or looks for: one not
// there yet (an import written before its module) is a file a watcher sees made. As Metro's file map does, it
// looks up each path once, a build's files not changing during it, and lists each directory once.
export function buildHost(host, read) {
  return lookups(host, read).host
}

// buildHost()'s host, and what it knows: `known(name, path)`, a path's isFile or realpath as looked up;
// entry(path), its entry in its directory's listing (null where none, undefined where none listed);
// forget(dir), that directory's listing let go.
function lookups(host, read) {
  // The resolver tries every spelling of each import (platform, extension) and each directory up to its package.json.
  const once = (find) => {
    const known = new Map()
    return Object.assign((path) => {
      if (!known.has(path)) known.set(path, find(path))
      return known.get(path)
    }, { known })
  }
  // A directory's typed entries (`dirents`, not @preventive/vfs's `entries`, an archive's): none where there
  // is no directory; null where it can't be listed (EACCES) or the host lists none, each path left to the host.
  const listing = once((dir) => {
    if (typeof host.dirents !== 'function') return null
    try {
      return new Map(host.dirents(dir).map((entry) => [entry.name, entry]))
    } catch (error) {
      return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? new Map() : null
    }
  })
  // A path's type as its directory lists it; as the host has it for a link or an entry of no type.
  const typed = (name) => (path) => {
    read.add(path)
    const entries = dirname(path) === path ? null : listing(dirname(path))
    const entry = entries?.get(basename(path))
    if (entries !== null && entry === undefined) return false
    if (entries === null || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) return host[name](path)
    return name === 'isFile' ? entry.isFile() : entry.isDirectory()
  }
  const looked = { isFile: once(typed('isFile')), isDirectory: once(typed('isDirectory')), realpath: once((path) => host.realpath(path)) }
  return {
    host: {
      ...looked,
      readdir: (path) => host.readdir(path),
      readFile: (path) => {
        read.add(path)
        return host.readFile(path)
      },
    },
    known: (name, path) => looked[name].known.get(path),
    entry: (path) => {
      const entries = dirname(path) === path ? null : listing(dirname(path))
      return entries === null ? undefined : (entries.get(basename(path)) ?? null)
    },
    forget: (dir) => listing.known.delete(dir),
  }
}

const plainFile = (entry) => entry != null && entry.isFile() && !entry.isSymbolicLink()

// buildHost() kept across a bundler's watcher-caused builds (resolutionOf()), noting each path it looked up
// or read, in each build's `read` too (attach(read)). keeps(changes) -> whether what it knows still holds
// after a watcher's changes ({ path, event }): not after a package.json changed, nor a path it looked up was
// added, removed or made another kind, nor one it looked up paths under was; a file's contents changing, or
// an editor's save by rename (still a plain file, not a link's), leave it; a path it never looked up, added
// or removed, its directory's listing alone.
export function keptLookups(host) {
  const seen = new Set()
  const under = new Set()
  let read = null
  const made = lookups(host, {
    add(path) {
      if (!seen.has(path)) {
        seen.add(path)
        for (let dir = dirname(path); !under.has(dir); dir = dirname(dir)) {
          under.add(dir)
          if (dirname(dir) === dir) break
        }
      }
      read?.add(path)
    },
  })
  const keeps = ({ path, event }) => {
    if (basename(path) === 'package.json') return false
    if (event === 'change') return true
    if (under.has(path)) return false
    const before = made.entry(path)
    made.forget(dirname(path))
    if (!seen.has(path)) return true
    return plainFile(before) && plainFile(made.entry(path)) && made.known('isFile', path) === true && (made.known('realpath', path) ?? path) === path
  }
  return {
    host: made.host,
    attach(buildRead) {
      read = buildRead
      for (const path of seen) buildRead.add(path)
    },
    keeps: (changes) => changes.every(keeps),
  }
}

// A bundler's resolver, kept in memory across its watcher-caused builds: (changes, read) => Metro's resolver,
// each resolution made once, its lookups (keptLookups()) noted in `read`; made anew of a full build (`changes`
// null: a bundle's first, or one `r` asks for) or of changes after which what it looked up no longer holds.
export function resolutionOf(run) {
  let kept = null
  return (changes, read) => {
    if (kept === null || changes === null || !kept.lookups.keeps(changes)) {
      const keptLooked = keptLookups(run.host)
      const resolveModule = metroResolverOf({ ...run, host: keptLooked.host })
      const made = new Map()
      kept = {
        lookups: keptLooked,
        resolveModule: (importer, specifier, options) => {
          const key = `${importer}\0${specifier}\0${JSON.stringify(options ?? null)}`
          if (!made.has(key)) made.set(key, resolveModule(importer, specifier, options))
          return made.get(key)
        },
      }
    }
    kept.lookups.attach(read)
    return kept.resolveModule
  }
}
