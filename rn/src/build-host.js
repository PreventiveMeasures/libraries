// A build's view of the project, as both bundle formats (bundle.js, serve/modules.js) have it: Metro's resolver
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
// each file it reads; run.resolution's (serve/resolution.js's), as run.changes (a watcher's, or null) leave it.
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
// forget(dir), that directory's listing let go (serve/resolution.js keeps it across builds).
export function lookups(host, read) {
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
