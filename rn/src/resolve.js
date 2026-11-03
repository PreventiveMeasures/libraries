// metro-resolver 0.87.2's resolve with the context Metro 0.87's DependencyGraph gives it, over a
// host (MIT, Copyright (c) Meta Platforms, Inc. and affiliates); no Haste or scheme resolvers.
// Internally, null is a miss to fall back from and FAILED fails the resolution.

import { basename, dirname, isAbsolute, join, normalize, posix, relative, resolve as resolvePath, sep, win32 } from 'node:path'

import { assetFiles, isAssetFile } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { FAILED, exportsTarget, importsTarget } from './exports.js'

const EMPTY = Object.freeze({ type: 'empty' })
const RELATIVE = /^\.\.?(?:\/|$)/u
const toPosix = (path) => path.replaceAll(sep, '/')
const variants = (subpath) => [subpath, `${subpath}.js`, `${subpath}.json`]
const memo = (map, key, make) => {
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}

export function createMetroResolver({
  host = diskHost,
  sourceExts = defaults.sourceExts,
  assetExts = defaults.assetExts,
  assetResolutions = defaults.assetResolutions,
  mainFields = defaults.mainFields,
  conditionNames = defaults.conditionNames,
  conditionsByPlatform = defaults.conditionsByPlatform,
  preferNativePlatform = true,
  nodeModulesPaths = [],
  extraNodeModules = null,
  disableHierarchicalLookup = false,
  packageExports = true,
  metroResolver = null,
  resolveRequest: custom = null,
  dev = false,
} = {}) {
  // Read by name at each lookup, as Metro does, so a Proxy works too.
  const extra = extraNodeModules ?? {}
  if (![...nodeModulesPaths, ...Object.values(extra)].every((path) => typeof path === 'string' && isAbsolute(path))) throw new TypeError('createMetroResolver: nodeModulesPaths and extraNodeModules take absolute paths')
  if (metroResolver !== null && typeof metroResolver.resolve !== 'function') throw new TypeError('createMetroResolver: metroResolver is a metro-resolver module, with its resolve')
  if (custom !== null && (typeof custom !== 'function' || metroResolver === null)) throw new TypeError('createMetroResolver: resolveRequest is a function, which metroResolver runs')
  const config = {
    host,
    sourceExts: [...sourceExts],
    assetExts: new Set(assetExts),
    assetResolutions: [...assetResolutions],
    mainFields: [...mainFields],
    conditionNames: [...conditionNames],
    byPlatform: new Map(Object.entries(conditionsByPlatform).map(([platform, names]) => [platform, [...names]])),
    preferNativePlatform,
    nodeModulesPaths: [...nodeModulesPaths],
    disableHierarchicalLookup,
    packageExports,
    custom,
    dev,
    extra,
    // Caches of package.json by file, package by path, real path by root, redirects by package.json.
    manifests: new Map(),
    packages: new Map(),
    roots: new Map(),
    redirects: new WeakMap(),
  }
  // Keyed like Metro's DependencyGraph _resolutionCache, so resolveRequest runs once per key too.
  const resolved = new Map()
  return (originModulePath, specifier, { platform = null, isESMImport = false } = {}) => {
    if (!isAbsolute(originModulePath)) throw new TypeError(`resolve: the origin must be an absolute path, not ${JSON.stringify(originModulePath)}`)
    const esm = isESMImport === true
    return memo(resolved, `${dirname(originModulePath)}\0${specifier}\0${esm ? 'esm' : 'cjs'}\0${platform}`, () => {
      const context = {
        ...config,
        origin: originModulePath,
        platform,
        isESMImport: esm,
        conditions: new Set(['default', esm ? 'import' : 'require', ...config.conditionNames, ...(config.byPlatform.get(platform) ?? [])]),
        suffixes: [...(platform === null ? [] : [`.${platform}`]), ...(preferNativePlatform ? ['.native'] : []), ''],
      }
      if (metroResolver !== null) return viaMetroResolver(metroResolver, context, specifier)
      const resolution = resolveRequest(context, specifier)
      return resolution === FAILED ? null : resolution
    })
  }
}

function resolveRequest(context, specifier) {
  if (RELATIVE.test(specifier) || isAbsolute(specifier)) return resolveModulePath(context, specifier) ?? FAILED
  const own = packageOf(context, context.origin)
  if (specifier.startsWith('#')) {
    if (own?.packageJson.imports == null) return FAILED
    const hit = packageTarget(context, own.rootPath, importsTarget(own.packageJson.imports, specifier, context.conditions))
    if (hit !== null) return hit
  }
  const redirected = own && match(context, variants(specifier), own.packageJson)
  if (redirected === false) return EMPTY
  if (typeof redirected === 'string') {
    if (RELATIVE.test(redirected)) return resolveModulePath(context, resolvePath(own.rootPath, redirected)) ?? FAILED
    if (posix.isAbsolute(redirected) || win32.isAbsolute(redirected)) return FAILED
  }
  const bare = toPosix(redirected ?? specifier)
  const parts = bare.split('/')
  const name = parts.slice(0, bare.startsWith('@') && parts.length > 1 ? 2 : 1).join('/')
  const subpath = `.${bare.slice(name.length)}`
  // A package importing itself by name.
  if (own?.packageJson.name === name) {
    const hit = fromExports(context, own, subpath)
    if (hit !== null) return hit
  }
  for (const nodeModules of nodeModulesDirs(context)) {
    // The shallowest directory that could hold it must exist.
    if (!context.host.isDirectory(parts.length > 1 ? `${nodeModules}${sep}${parts[0]}` : nodeModules)) continue
    const hit = fromTargetPath(context, `${nodeModules}${sep}${bare.replaceAll('/', sep)}`)
    if (hit !== null) return hit
  }
  const extra = context.extra[name]
  if (typeof extra !== 'string') return FAILED
  if (!isAbsolute(extra)) throw new TypeError(`createMetroResolver: extraNodeModules takes absolute paths, not ${JSON.stringify(extra)} for ${name}`)
  return fromTargetPath(context, join(extra, subpath)) ?? FAILED
}

// Each node_modules from the origin up, then the other nodeModulesPaths: alone if not hierarchical.
function nodeModulesDirs({ origin, nodeModulesPaths, disableHierarchicalLookup }) {
  if (disableHierarchicalLookup) return nodeModulesPaths
  const above = []
  for (let dir = dirname(origin); ; dir = dirname(dir)) {
    above.push(dir.endsWith(sep) ? `${dir}node_modules` : `${dir}${sep}node_modules`)
    if (dirname(dir) === dir) break
  }
  return [...above, ...nodeModulesPaths.filter((path) => !above.includes(path))]
}

function fromTargetPath(context, targetPath) {
  const candidate = redirect(context, targetPath)
  if (candidate === false) return EMPTY
  const pkg = packageOf(context, candidate)
  return fromExports(context, pkg, pkg?.packageRelativePath ? `./${pkg.packageRelativePath}` : '.') ?? resolveModulePath(context, candidate)
}

function fromExports(context, pkg, subpath) {
  if (!context.packageExports || pkg?.packageJson.exports == null) return null
  return packageTarget(context, pkg.rootPath, exportsTarget(pkg.packageJson.exports, subpath, context.conditions))
}

// A package map's target is taken as is: no extension or index is probed.
function packageTarget(context, rootPath, target) {
  if (typeof target !== 'string') return target
  const filePath = join(rootPath, target)
  const asset = isAssetFile(filePath, context.assetExts) ? assetResolution(context, filePath) : null
  return asset ?? (context.host.isFile(filePath) ? sourceFile(context, filePath) : null)
}

// As a file, then as a directory; a trailing slash asks for the directory.
function resolveModulePath(context, toModuleName) {
  const redirected = redirect(context, isAbsolute(toModuleName) ? toModuleName : join(dirname(context.origin), toModuleName))
  if (redirected === false) return EMPTY
  return (redirected.endsWith(sep) ? null : resolveFile(context, dirname(redirected), basename(redirected))) ?? resolvePackageEntryPoint(context, redirected)
}

// With a package.json, its main module as a file or a directory's index, failing if neither
// exists; without one, the directory's index.
function resolvePackageEntryPoint(context, packagePath) {
  if (!context.host.isDirectory(packagePath)) return null
  const manifest = join(packagePath, 'package.json')
  if (!context.host.isFile(manifest)) return resolveFile(context, packagePath, 'index')
  const main = join(packagePath, entryPoint(context, read(context, manifest)))
  return resolveFile(context, dirname(main), basename(main)) ?? resolveFile(context, main, 'index') ?? FAILED
}

// The name itself, then for each source extension the platform, native and plain files, each
// through its package's redirects.
function resolveFile(context, dirPath, fileName) {
  const prefix = join(dirPath, fileName)
  if (isAssetFile(fileName, context.assetExts)) return assetResolution(context, prefix)
  if (context.host.isFile(prefix)) return sourceFile(context, prefix)
  for (const ext of context.sourceExts) {
    for (const suffix of context.suffixes) {
      const candidate = redirect(context, `${prefix}${suffix}.${ext}`)
      if (candidate === false) return EMPTY
      if (context.host.isFile(candidate)) return sourceFile(context, candidate)
    }
  }
  return null
}

const sourceFile = ({ host }, filePath) => ({ type: 'sourceFile', filePath: host.realpath(filePath) })

function assetResolution({ host, assetResolutions }, filePath) {
  const filePaths = assetFiles(host, filePath, assetResolutions)
  return filePaths === null ? null : { type: 'assetFiles', filePaths }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function read({ host, manifests }, file) {
  return memo(manifests, file, () => {
    let manifest
    try {
      manifest = JSON.parse(decoder.decode(host.readFile(file)))
    } catch (cause) {
      throw new Error(`Invalid package.json: ${file}`, { cause })
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`Invalid package.json: ${file}: not an object`)
    return manifest
  })
}

// The closest package.json as Metro's hierarchicalLookup finds it: a directory's own, else the
// nearest above `path` as spelled, stopping at node_modules. A missing path searches from its
// deepest existing ancestor, finding none if the first missing directory is a node_modules.
function packageOf(context, path) {
  return memo(context.packages, path, () => {
    const { host } = context
    const found = (dir) => ({ rootPath: memo(context.roots, dir, () => host.realpath(dir)), packageJson: read(context, join(dir, 'package.json')), packageRelativePath: toPosix(relative(dir, path)) })
    const isDirectory = host.isDirectory(path)
    if (isDirectory && host.isFile(join(path, 'package.json'))) return found(path)
    let below = path
    if (!isDirectory && !host.isFile(path)) {
      while (dirname(below) !== below && !host.isDirectory(dirname(below))) below = dirname(below)
      if (basename(below) === 'node_modules') return null
    }
    for (let dir = dirname(below); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
      if (host.isFile(join(dir, 'package.json'))) return found(dir)
      if (dirname(dir) === dir) return null
    }
    return null
  })
}

// The browser-spec redirects of the object-valued mainFields, earlier fields winning: a string,
// false for an empty module, or null for none.
function match({ mainFields, redirects }, subpaths, pkg) {
  const map = memo(redirects, pkg, () => {
    const merged = new Map()
    for (const field of mainFields.toReversed()) {
      const value = pkg[field]
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [key, to] of Object.entries(value)) {
        if (typeof to === 'string' || to === false) {
          merged.set(key, to)
        } else {
          merged.delete(key)
        }
      }
    }
    return merged
  })
  return map.get(subpaths.find((subpath) => map.has(subpath))) ?? null
}

// metro-resolver's redirectModulePath: an absolute path by its package's map; a relative path or
// a name by the origin package's. A string redirect of a path is relative to the package root,
// even where it names another package.
function redirect(context, modulePath) {
  const absolute = isAbsolute(modulePath)
  const pkg = packageOf(context, absolute ? modulePath : context.origin)
  if (pkg === null) return modulePath
  if (!absolute && !modulePath.startsWith('.')) return match(context, variants(modulePath), pkg.packageJson) ?? modulePath
  const subpath = absolute ? pkg.packageRelativePath : toPosix(join(dirname(pkg.packageRelativePath), modulePath))
  const to = match(context, variants(`./${subpath}`), pkg.packageJson)
  if (typeof to !== 'string') return to ?? modulePath
  return isAbsolute(to) ? normalize(to) : join(pkg.rootPath, to)
}

// getPackageEntryPoint: the first mainField naming one, else `index`, redirected by its first
// spelling that has a redirect; a false redirect keeps it.
function entryPoint(context, pkg) {
  const main = context.mainFields.map((field) => pkg[field]).find((value) => typeof value === 'string' && value.length > 0) ?? 'index'
  const spellings = [main, main.startsWith('./') ? main.slice(2) : `./${main}`].flatMap((spelling) => [...variants(spelling), spelling.replace(/\.js$|\.json$/u, '')])
  const to = match(context, spellings, pkg)
  return typeof to === 'string' ? to : main
}

// metro-resolver's resolution errors, by name, so any copy of it is recognized.
const FAILURES = new Set(['FailedToResolveNameError', 'FailedToResolvePathError', 'FailedToResolveUnsupportedError', 'InvalidPackageError', 'InvalidPackageConfigurationError', 'PackageImportNotResolvedError', 'PackagePathNotExportedError'])

// metro-resolver's resolve (0.81 to 0.87) with the context Metro's DependencyGraph builds. Its
// failures are null (even 0.87's TypeError on a number `exports`); host and package.json errors
// throw, and so does any other error with a resolveRequest, as Metro's build fails with it.
function viaMetroResolver(metroResolver, context, specifier) {
  const { host } = context
  // Errors thrown by our own callbacks are rethrown, not taken for failures to resolve.
  let thrown
  const ours = (callback) => (...args) => {
    try {
      return callback(...args)
    } catch (error) {
      thrown = error
      throw error
    }
  }
  const metroContext = {
    allowHaste: false,
    assetExts: context.assetExts,
    customResolverOptions: {},
    // Just what the resolver reads of Metro's dependency.
    dependency: { name: specifier, data: { key: specifier, asyncType: null, isESMImport: context.isESMImport, locs: [] } },
    dev: context.dev,
    disableHierarchicalLookup: context.disableHierarchicalLookup,
    doesFileExist: ours((path) => host.isFile(path)),
    extraNodeModules: context.extra,
    fileSystemLookup: ours((path) => {
      const type = host.isFile(path) ? 'f' : host.isDirectory(path) ? 'd' : null
      return type === null ? { exists: false } : { exists: true, type, realPath: host.realpath(path) }
    }),
    // Metro takes an invalid package.json for none here.
    getPackage: (path) => {
      try {
        return read(context, path)
      } catch {
        return null
      }
    },
    getPackageForModule: ours((path) => {
      const pkg = packageOf(context, path)
      return pkg && { ...pkg, packageRelativePath: pkg.packageRelativePath.replaceAll('/', sep) }
    }),
    isESMImport: context.isESMImport,
    mainFields: context.mainFields,
    nodeModulesPaths: context.nodeModulesPaths,
    originModulePath: context.origin,
    preferNativePlatform: context.preferNativePlatform,
    redirectModulePath: ours((modulePath) => redirect(context, modulePath)),
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    ...(context.custom !== null && { resolveRequest: context.custom }),
    resolveAsset: ours((dirPath, assetName, extension) => assetFiles(host, join(dirPath, `${assetName}${extension}`), context.assetResolutions)),
    schemeResolvers: {},
    sourceExts: context.sourceExts,
    unstable_conditionNames: context.conditionNames,
    unstable_conditionsByPlatform: Object.fromEntries(context.byPlatform),
    unstable_enablePackageExports: context.packageExports,
    unstable_logWarning: () => {},
  }
  try {
    return metroResolver.resolve(metroContext, specifier, context.platform)
  } catch (error) {
    if (error === thrown || (context.custom !== null && !FAILURES.has(error?.constructor?.name))) throw error
    return null
  }
}
