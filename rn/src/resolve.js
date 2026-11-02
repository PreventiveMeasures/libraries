// Metro's module resolution: metro-resolver 0.87.2's resolve.js with the
// context Metro 0.87's DependencyGraph gives it (MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates), over a host. No Haste, resolveRequest or
// scheme resolvers. Null where Metro throws; a package.json that is no JSON
// object throws, as in Metro. Inside, null is a miss to fall back from and
// FAILED fails the resolution. With `metroResolver` (0.81 on; the project's
// own, for its Metro's exact rules), that module resolves instead, given the
// same context over the host.

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
  metroResolver = null,
} = {}) {
  // Read by name at each lookup, as Metro reads it: a Proxy's names too.
  const extra = extraNodeModules ?? {}
  if (![...nodeModulesPaths, ...Object.values(extra)].every((path) => typeof path === 'string' && isAbsolute(path))) throw new TypeError('createMetroResolver: nodeModulesPaths and extraNodeModules take absolute paths')
  if (metroResolver !== null && typeof metroResolver.resolve !== 'function') throw new TypeError('createMetroResolver: metroResolver is a metro-resolver module, with its resolve')
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
    extra,
    // Each package.json, package root and redirect map, read once.
    manifests: new Map(),
    roots: new Map(),
    redirects: new WeakMap(),
  }
  return (originModulePath, specifier, { platform = null, isESMImport = false } = {}) => {
    if (!isAbsolute(originModulePath)) throw new TypeError(`resolve: the origin must be an absolute path, not ${JSON.stringify(originModulePath)}`)
    const context = {
      ...config,
      origin: originModulePath,
      platform,
      isESMImport: isESMImport === true,
      conditions: new Set(['default', isESMImport === true ? 'import' : 'require', ...config.conditionNames, ...(config.byPlatform.get(platform) ?? [])]),
      suffixes: [...(platform === null ? [] : [`.${platform}`]), ...(preferNativePlatform ? ['.native'] : []), ''],
    }
    if (metroResolver !== null) return viaMetroResolver(metroResolver, context, specifier)
    const resolution = resolveRequest(context, specifier)
    return resolution === FAILED ? null : resolution
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
  const redirected = own === null ? null : match(context, variants(specifier), own.packageJson)
  if (redirected === false) return EMPTY
  if (redirected !== null && RELATIVE.test(redirected)) return resolveModulePath(context, resolvePath(own.rootPath, redirected)) ?? FAILED
  if (redirected !== null && (posix.isAbsolute(redirected) || win32.isAbsolute(redirected))) return FAILED
  const bare = toPosix(redirected ?? specifier)
  const parts = bare.split('/')
  const name = parts.slice(0, bare.startsWith('@') && parts.length > 1 ? 2 : 1).join('/')
  const subpath = `.${bare.slice(name.length)}`
  // A package importing itself by name.
  if (own?.packageJson.exports != null && own.packageJson.name === name) {
    const hit = packageTarget(context, own.rootPath, exportsTarget(own.packageJson.exports, subpath, context.conditions))
    if (hit !== null) return hit
  }
  for (const nodeModules of nodeModulesDirs(context)) {
    // The shallowest directory that could hold it must be one.
    if (!context.host.isDirectory(bare.includes('/') ? `${nodeModules}${sep}${parts[0]}` : nodeModules)) continue
    const hit = fromTargetPath(context, `${nodeModules}${sep}${bare.replaceAll('/', sep)}`)
    if (hit !== null) return hit
  }
  const extra = context.extra[name]
  if (typeof extra !== 'string') return FAILED
  if (!isAbsolute(extra)) throw new TypeError(`createMetroResolver: extraNodeModules takes absolute paths, not ${JSON.stringify(extra)} for ${name}`)
  return fromTargetPath(context, join(extra, subpath)) ?? FAILED
}

// Each node_modules from the origin up, then `nodeModulesPaths` not among
// them; those alone without hierarchical lookup.
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
  if (pkg?.packageJson.exports != null) {
    const subpath = pkg.packageRelativePath === '' ? '.' : `./${pkg.packageRelativePath}`
    const hit = packageTarget(context, pkg.rootPath, exportsTarget(pkg.packageJson.exports, subpath, context.conditions))
    if (hit !== null) return hit
  }
  return resolveModulePath(context, candidate)
}

// A package map's target, taken as it is: no extension or index probed.
function packageTarget(context, rootPath, target) {
  if (target === null || target === FAILED) return target
  const filePath = join(rootPath, target)
  return (isAssetFile(filePath, context.assetExts) ? assetResolution(context, filePath) : null) ?? (context.host.isFile(filePath) ? sourceFile(context, filePath) : null)
}

// As a file, then as a directory; a trailing slash asks for the directory.
function resolveModulePath(context, toModuleName) {
  const redirected = redirect(context, isAbsolute(toModuleName) ? toModuleName : join(dirname(context.origin), toModuleName))
  if (redirected === false) return EMPTY
  return (redirected.endsWith(sep) ? null : resolveFile(context, dirname(redirected), basename(redirected))) ?? resolvePackageEntryPoint(context, redirected)
}

// Its main module, else that as a directory's index; a package.json naming
// neither fails.
function resolvePackageEntryPoint(context, packagePath) {
  if (!context.host.isDirectory(packagePath)) return null
  const manifest = join(packagePath, 'package.json')
  if (!context.host.isFile(manifest)) return resolveFile(context, packagePath, 'index')
  const main = join(packagePath, entryPoint(context, read(context, manifest)))
  return resolveFile(context, dirname(main), basename(main)) ?? resolveFile(context, main, 'index') ?? FAILED
}

// The name itself, then for each source extension the platform's file, the
// native one and the plain one, each through its package's redirects.
function resolveFile(context, dirPath, fileName) {
  if (isAssetFile(fileName, context.assetExts)) return assetResolution(context, join(dirPath, fileName))
  const prefix = join(dirPath, fileName)
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

// The closest package.json, as Metro's file map's hierarchicalLookup finds
// it: a directory's own, else the directories above as `path` spells them,
// none past a node_modules, from the deepest one there (a missing
// node_modules on the way finds none). The root by its real path, the
// package-relative path posix.
function packageOf(context, path) {
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
}

// The "browser"-spec redirects of the object-valued mainFields, earlier
// fields winning: a string, false (an empty module), or null for none.
function match({ mainFields, redirects }, subpaths, pkg) {
  const map = memo(redirects, pkg, () => {
    let merged = null
    for (const field of mainFields.toReversed()) {
      const value = pkg[field]
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      merged ??= new Map()
      for (const [key, to] of Object.entries(value)) {
        if (typeof to === 'string' || to === false) merged.set(key, to)
        else merged.delete(key)
      }
    }
    return merged
  })
  const key = map === null ? undefined : subpaths.find((subpath) => map.has(subpath))
  return key === undefined ? null : map.get(key)
}

// redirectModulePath: a string target is relative to the package, even where
// it names another.
function redirect(context, path) {
  const pkg = packageOf(context, path)
  if (pkg === null) return path
  const to = match(context, variants(`./${pkg.packageRelativePath}`), pkg.packageJson)
  if (typeof to !== 'string') return to ?? path
  return isAbsolute(to) ? normalize(to) : join(pkg.rootPath, to)
}

// getPackageEntryPoint: the first mainField naming one, else `index`, through
// the redirects of its first spelling that has one; a false one keeps it.
function entryPoint(context, pkg) {
  const main = context.mainFields.map((field) => pkg[field]).find((value) => typeof value === 'string' && value.length > 0) ?? 'index'
  const spellings = [main, main.startsWith('./') ? main.slice(2) : `./${main}`].flatMap((spelling) => [...variants(spelling), spelling.replace(/\.js$|\.json$/u, '')])
  const to = match(context, spellings, pkg)
  return typeof to === 'string' ? to : main
}

// metro-resolver's resolve, given what of Metro's context 0.81 to 0.87 read.
// Its failures are null; the host's errors, and a bad package.json's, throw.
function viaMetroResolver(metroResolver, context, specifier) {
  const { host } = context
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
    assetExts: context.assetExts,
    disableHierarchicalLookup: context.disableHierarchicalLookup,
    doesFileExist: ours((path) => host.isFile(path)),
    extraNodeModules: context.extra,
    fileSystemLookup: ours((path) => {
      const type = host.isFile(path) ? 'f' : host.isDirectory(path) ? 'd' : null
      return type === null ? { exists: false } : { exists: true, type, realPath: host.realpath(path) }
    }),
    // Metro reads a bad package.json as none here.
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
    resolveAsset: ours((dirPath, assetName, extension) => assetFiles(host, join(dirPath, `${assetName}${extension}`), context.assetResolutions)),
    sourceExts: context.sourceExts,
    unstable_conditionNames: context.conditionNames,
    unstable_conditionsByPlatform: Object.fromEntries(context.byPlatform),
    unstable_enablePackageExports: true,
    unstable_logWarning: () => {},
  }
  try {
    return metroResolver.resolve(metroContext, specifier, context.platform)
  } catch (error) {
    if (error === thrown) throw error
    return null
  }
}
