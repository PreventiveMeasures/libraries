// A build's view of the project, as both bundle formats (bundle.js, rn-serve's modules.js) have it: Metro's resolver
// over a host that notes each file it reads or looks for, for a watcher, and the assets built.

import { basename, dirname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { aliasing } from './babel-aliases.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

// The key of the empty module, which Metro resolves some imports to, and the namespace of assets' modules.
export const EMPTY = 'metro-empty'
export const ASSET = 'metro-asset'

export const posixRelative = (from, to) => relative(from, to).replaceAll('\\', '/')

// A build's state, resolving through buildHost() (each package.json read anew, each file read noted in
// `read`) or run.resolution (rn-serve's resolution.js). made(state) gets it before react-native's modules are
// found, which may fail (a package.json of no JSON): the build goes on with it, as with no react-native.
export function newState(run, read = new Set(), made = () => {}) {
  const { projectRoot, entry, platform } = run
  const host = buildHost(run.host, read)
  const resolveModule = run.resolution?.(run.changes ?? null, read) ?? metroResolverOf({ ...run, host })
  const resolution = importResolution(resolveModule, run)
  const graph = new Map()
  const assets = new Map()
  let registry = run.assetRegistryPath
  const state = {
    read,
    graph,
    before: run.runBeforeMain ?? [],
    // Resolves an import as importResolution() does, recording it in `graph`; returns resolvedModule() of it.
    resolveImport(importer, specifier, kind, pluginData) {
      const resolved = resolution(importer, specifier, kind, pluginData)
      if (!graph.has(importer)) graph.set(importer, new Map())
      graph.get(importer).set(specifier, resolved)
      return resolvedModule(resolved)
    },
    // The files it reads are noted even if that fails (an empty image).
    assetSource(path) {
      const data = assetDataOf({ projectRoot, platform, host }, path)
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

// (importer, specifier, kind, pluginData) => Metro's resolution of an import, by esbuild's kind, or null.
// pluginData is the importer's loadFile() data: `imports`, the specifiers of its ES imports, which a require
// call Babel made of one resolves as; `aliases`, module-resolver's Babel left (load.js), else `aliases`.
export function importResolution(resolveModule, { platform, aliases = null }) {
  return (importer, specifier, kind, { imports = [], aliases: mapped = null } = {}) => {
    const isESMImport = kind === 'import-statement' || kind === 'dynamic-import' || (kind === 'require-call' && imports.includes(specifier))
    const map = mapped === null ? aliases : aliasing(mapped)
    return resolveModule(importer, map?.(importer, specifier) ?? specifier, { platform, isESMImport })
  }
}

// A resolution as the bundle takes it: the module, { kind, key }, or null where nothing. Metro builds an
// asset into the module of its lowest path; its `files` are those of each scale.
export function resolvedModule(resolution) {
  if (resolution === null) return null
  if (resolution.type === 'empty') return { kind: 'empty', key: EMPTY }
  if (resolution.type === 'assetFiles') {
    const files = resolution.filePaths.toSorted()
    return { kind: 'asset', key: files[0], files }
  }
  return { kind: 'file', key: resolution.filePath }
}

// Metro's AssetData of an asset of the project, its URL its path from the project root.
export const assetDataOf = ({ projectRoot, platform, host }, path) => assetData(path, { urlPath: posixRelative(projectRoot, path), platform, host })

// Metro's resolver over the host, seeing no file `blockList` matches, as Metro's file map has none.
export function metroResolverOf({ host, assetExts, resolver = {}, blockList = null }) {
  const seen = blockList === null ? host : { ...host, isFile: (path) => !blockList.some((pattern) => pattern.test(path)) && host.isFile(path) }
  return createMetroResolver({ ...resolver, host: seen, assetExts })
}

// The host a build uses, noting in `read` each path it reads or looks for, so a watcher sees one made later
// (an import written before its module). As Metro's file map, it looks up each path and lists each dir once.
export function buildHost(host, read) {
  return lookups(host, read).host
}

// buildHost()'s host, and what it knows: `known(name, path)`, a path's isFile or realpath as looked up;
// entry(path), its entry in its directory's listing (null where none, undefined where none listed);
// forget(dir), that directory's listing let go (rn-serve's resolution.js keeps it across builds).
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
  const entry = (path) => {
    const entries = dirname(path) === path ? null : listing(dirname(path))
    return entries === null ? undefined : (entries.get(basename(path)) ?? null)
  }
  // A path's type as its directory lists it; as the host has it for a link or an entry of no type.
  const typed = (name) => (path) => {
    read.add(path)
    const listed = entry(path)
    if (listed === null) return false
    if (listed === undefined || listed.isSymbolicLink() || !(listed.isFile() || listed.isDirectory())) return host[name](path)
    return listed[name]()
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
    entry,
    forget: (dir) => listing.known.delete(dir),
  }
}
