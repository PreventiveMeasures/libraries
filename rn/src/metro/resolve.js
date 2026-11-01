// Metro's module resolution (metro-resolver's resolve.js, with the context
// Metro's DependencyGraph gives it), run over a tree read through a host,
// with no Haste, no custom resolveRequest and no scheme resolvers (Metro's
// own `metro:` specifiers, which its transforms insert, name Metro's install,
// not the tree's). It reads package.json files and asks what is a file or a
// directory: no code of the tree runs. Mirrors metro-resolver 0.87.2 and
// Metro 0.87, MIT licensed, Copyright (c) Meta Platforms, Inc. and
// affiliates.
//
// Where Metro throws, this answers null, every failure alike: a path that is
// no module, a package whose main module is missing, a "browser" redirect to
// an absolute path, a `#` specifier from a package with no "imports", an
// "exports" that is a number or a boolean. Inside, a step answers null to
// fall back, FAILED to fail the whole resolution. A package.json that is
// there but is no JSON object throws, as it does in Metro.

import { basename, dirname, isAbsolute, join, posix, resolve as resolvePath, sep, win32 } from 'node:path'

import { diskHost } from '../host.js'
import { assetFiles, extensionSet, isAssetFile } from './asset-paths.js'
import { defaults } from './defaults.js'
import { FAILED, exportsTarget, importsTarget } from './exports.js'
import { createPackages, selfAndAncestors, toPosix } from './package.js'

const EMPTY = Object.freeze({ type: 'empty' })
const RELATIVE = /^\.\.?(?:\/|$)/u

export function createMetroResolver(options = {}) {
  const {
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
  } = options
  const extra = new Map(Object.entries(extraNodeModules ?? {}))
  for (const path of [...nodeModulesPaths, ...extra.values()]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`createMetroResolver: nodeModulesPaths and extraNodeModules take absolute paths, not ${JSON.stringify(path)}`)
  }
  const config = {
    host,
    sourceExts: [...sourceExts],
    assetExts: extensionSet(assetExts),
    assetResolutions: [...assetResolutions],
    nodeModulesPaths: [...nodeModulesPaths],
    extraNodeModules: extra,
    disableHierarchicalLookup,
    packages: createPackages(host, [...mainFields]),
  }
  const names = [...conditionNames]
  const byPlatform = new Map(Object.entries(conditionsByPlatform).map(([platform, list]) => [platform, [...list]]))
  return function resolve(originModulePath, specifier, { platform = null, isESMImport = false } = {}) {
    if (typeof originModulePath !== 'string' || !isAbsolute(originModulePath)) throw new TypeError(`resolve: the origin must be an absolute path, not ${JSON.stringify(originModulePath)}`)
    if (typeof specifier !== 'string') throw new TypeError(`resolve: the specifier must be a string, not ${typeof specifier}`)
    const context = {
      ...config,
      origin: originModulePath,
      // What a package's "exports" and "imports" are read with: `default`,
      // `import` or `require`, the names given, and the platform's.
      conditions: new Set(['default', isESMImport === true ? 'import' : 'require', ...names, ...(platform === null ? [] : (byPlatform.get(platform) ?? []))]),
      // What a source file's name is tried with before each extension.
      suffixes: [...(platform === null ? [] : [`.${platform}`]), ...(preferNativePlatform ? ['.native'] : []), ''],
    }
    const resolution = resolveRequest(context, specifier)
    return resolution === FAILED ? null : resolution
  }
}

function resolveRequest(context, specifier) {
  const { origin, packages } = context
  if (RELATIVE.test(specifier) || isAbsolute(specifier)) return resolveModulePath(context, specifier) ?? FAILED
  const own = packages.forModule(origin)
  if (specifier.startsWith('#')) {
    if (own?.packageJson.imports == null) return FAILED
    const hit = packageTarget(context, own.rootPath, importsTarget(own.packageJson.imports, specifier, context.conditions))
    if (hit !== null) return hit
  }
  // The importer's own package may redirect a bare specifier: to a path in
  // it, to another specifier, or to nothing.
  const redirected = own === null ? null : packages.matchSpecifier(specifier, own.packageJson)
  if (redirected === false) return EMPTY
  if (redirected !== null && RELATIVE.test(redirected)) return resolveModulePath(context, resolvePath(own.rootPath, redirected)) ?? FAILED
  if (redirected !== null && (posix.isAbsolute(redirected) || win32.isAbsolute(redirected))) return FAILED
  const bare = parseBareSpecifier(redirected ?? specifier)
  // A package importing itself by its name, through its own "exports".
  if (own?.packageJson.exports != null && own.packageJson.name === bare.packageName) {
    const hit = packageTarget(context, own.rootPath, exportsTarget(own.packageJson.exports, bare.posixSubpath, context.conditions))
    if (hit !== null) return hit
  }
  for (const nodeModules of nodeModulesDirs(context)) {
    const hit = fromNodeModules(context, bare, nodeModules)
    if (hit !== null) return hit
  }
  const extra = context.extraNodeModules.get(bare.packageName)
  return (extra === undefined ? null : fromTargetPath(context, join(extra, bare.posixSubpath))) ?? FAILED
}

// Every node_modules from the origin's directory up, then each of
// `nodeModulesPaths` not among them; those alone without hierarchical lookup.
function nodeModulesDirs({ origin, nodeModulesPaths, disableHierarchicalLookup }) {
  if (disableHierarchicalLookup) return nodeModulesPaths
  const above = [...selfAndAncestors(dirname(origin))].map((dir) => (dir.endsWith(sep) ? `${dir}node_modules` : `${dir}${sep}node_modules`))
  return [...above, ...nodeModulesPaths.filter((nodeModules) => !above.includes(nodeModules))]
}

// A bare specifier in the node_modules at `nodeModules`, where the shallowest
// directory that could hold it is one: the package's, or its scope's.
function fromNodeModules(context, bare, nodeModules) {
  const nested = bare.posixSubpath !== '.' || bare.packageName.length > bare.firstPart.length
  if (!context.host.isDirectory(nested ? `${nodeModules}${sep}${bare.firstPart}` : nodeModules)) return null
  return fromTargetPath(context, `${nodeModules}${sep}${bare.normalizedSpecifier.replaceAll('/', sep)}`)
}

// A package's directory or a path in it, through the redirects of the package
// closest to it, then through the "exports" of the one closest to where that
// lands, else as a path. Null where none resolves it; a package there whose
// main module is missing fails the resolution.
function fromTargetPath(context, targetPath) {
  const candidate = context.packages.redirect(targetPath)
  if (candidate === false) return EMPTY
  const pkg = context.packages.forModule(candidate)
  if (pkg?.packageJson.exports != null) {
    const subpath = pkg.packageRelativePath === '' ? '.' : `./${pkg.packageRelativePath}`
    const hit = packageTarget(context, pkg.rootPath, exportsTarget(pkg.packageJson.exports, subpath, context.conditions))
    if (hit !== null) return hit
  }
  return resolveModulePath(context, candidate)
}

// The file a package map's target names in the package at `rootPath`, no
// extension or index probed: an asset with its scale variants, else the file
// itself; null where it names none, Metro's cue to resolve by files instead.
function packageTarget(context, rootPath, target) {
  if (target === null || target === FAILED) return target
  const filePath = join(rootPath, target)
  const asset = isAssetFile(filePath, context.assetExts) ? assetResolution(context, filePath) : null
  return asset ?? (context.host.isFile(filePath) ? sourceFile(context, filePath) : null)
}

// A relative or absolute path, through the redirects of the package closest
// to it, as a file, else as a directory: a trailing slash asks for the
// directory alone.
function resolveModulePath(context, toModuleName) {
  const modulePath = isAbsolute(toModuleName) ? toModuleName : join(dirname(context.origin), toModuleName)
  const redirected = context.packages.redirect(modulePath)
  if (redirected === false) return EMPTY
  const file = redirected.endsWith(sep) ? null : resolveFile(context, dirname(redirected), basename(redirected))
  return file ?? resolvePackageEntryPoint(context, redirected)
}

// A directory as a module: its package.json's main module, else that as a
// directory's index, failing the resolution where neither is there; with no
// package.json, its index.
function resolvePackageEntryPoint(context, packagePath) {
  const { host, packages } = context
  if (!host.isDirectory(packagePath)) return null
  const manifest = join(packagePath, 'package.json')
  if (!host.isFile(manifest)) return resolveFile(context, packagePath, 'index')
  const main = join(packagePath, packages.entryPoint(packages.read(manifest)))
  return resolveFile(context, dirname(main), basename(main)) ?? resolveFile(context, main, 'index') ?? FAILED
}

// `fileName` in `dirPath` as an asset, at its scales, where its extension is
// an asset's; else as a source file: the name itself, then for each source
// extension the platform's file, the native one, the plain one, each through
// its package's redirects.
function resolveFile(context, dirPath, fileName) {
  const { host, packages } = context
  if (isAssetFile(fileName, context.assetExts)) return assetResolution(context, join(dirPath, fileName))
  const prefix = join(dirPath, fileName)
  if (host.isFile(prefix)) return sourceFile(context, prefix)
  for (const ext of context.sourceExts) {
    for (const suffix of context.suffixes) {
      const candidate = packages.redirect(`${prefix}${suffix}.${ext}`)
      if (candidate === false) return EMPTY
      if (host.isFile(candidate)) return sourceFile(context, candidate)
    }
  }
  return null
}

const sourceFile = ({ host }, filePath) => ({ type: 'sourceFile', filePath: host.realpath(filePath) })

function assetResolution({ host, assetResolutions }, filePath) {
  const filePaths = assetFiles(host, filePath, assetResolutions)
  return filePaths === null ? null : { type: 'assetFiles', filePaths }
}

// A bare specifier's package name, its first segment, and its subpath (`.`
// or `./x`), as Metro splits one.
function parseBareSpecifier(specifier) {
  const normalizedSpecifier = toPosix(specifier)
  const first = normalizedSpecifier.indexOf('/')
  const second = normalizedSpecifier.startsWith('@') && first !== -1 ? normalizedSpecifier.indexOf('/', first + 1) : first
  const end = second === -1 ? normalizedSpecifier.length : second
  return {
    firstPart: first === -1 ? normalizedSpecifier : normalizedSpecifier.slice(0, first),
    normalizedSpecifier,
    packageName: normalizedSpecifier.slice(0, end),
    posixSubpath: second === -1 ? '.' : `.${normalizedSpecifier.slice(second)}`,
  }
}
