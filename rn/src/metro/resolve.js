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
// "exports" that is a number or a boolean. A package.json that is there but
// is no JSON object throws, as it does in Metro.

import { basename, dirname, isAbsolute, join, posix, resolve as resolvePath, sep, win32 } from 'node:path'

import { diskHost } from '../host.js'
import { assetFiles, extensionSet, isAssetFile } from './asset-paths.js'
import * as defaults from './defaults.js'
import { MetroFailure, exportsTarget, importsTarget } from './exports.js'
import { createPackages } from './package.js'

const EMPTY = Object.freeze({ type: 'empty' })
const RELATIVE = /^\.\.?(?:\/|$)/u
const toPosix = (path) => (sep === '/' ? path : path.replaceAll(sep, '/'))
const fail = (reason) => {
  throw new MetroFailure(reason)
}

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
  for (const path of [...nodeModulesPaths, ...Object.values(extraNodeModules ?? {})]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`createMetroResolver: nodeModulesPaths and extraNodeModules take absolute paths, not ${JSON.stringify(path)}`)
  }
  const config = {
    host,
    sourceExts: [...sourceExts],
    assetExts: extensionSet(assetExts),
    assetResolutions: [...assetResolutions],
    preferNativePlatform,
    nodeModulesPaths: [...nodeModulesPaths],
    extraNodeModules: new Map(Object.entries(extraNodeModules ?? {})),
    disableHierarchicalLookup,
    packages: createPackages(host, [...mainFields]),
  }
  // The conditions of a request: `default`, `import` or `require`, the names
  // given, and the platform's. Made once for each platform and kind.
  const conditionSets = new Map()
  const conditionsFor = (platform, isESMImport) => {
    const key = `${isESMImport}\0${platform}`
    if (!conditionSets.has(key)) {
      const byPlatform = platform !== null && Object.hasOwn(conditionsByPlatform, platform) ? conditionsByPlatform[platform] : []
      conditionSets.set(key, new Set(['default', isESMImport ? 'import' : 'require', ...conditionNames, ...byPlatform]))
    }
    return conditionSets.get(key)
  }
  return function resolve(originModulePath, specifier, { platform = null, isESMImport = false } = {}) {
    if (typeof originModulePath !== 'string' || !isAbsolute(originModulePath)) throw new TypeError(`resolve: the origin must be an absolute path, not ${JSON.stringify(originModulePath)}`)
    if (typeof specifier !== 'string') throw new TypeError(`resolve: the specifier must be a string, not ${typeof specifier}`)
    const context = { ...config, origin: originModulePath, platform, conditions: conditionsFor(platform, isESMImport === true) }
    try {
      return resolveRequest(context, specifier)
    } catch (error) {
      if (error instanceof MetroFailure) return null
      throw error
    }
  }
}

function resolveRequest(context, specifier) {
  const { origin, packages } = context
  if (RELATIVE.test(specifier) || isAbsolute(specifier)) return resolveModulePath(context, specifier) ?? fail(`Cannot resolve ${specifier}`)
  const own = packages.forModule(origin)
  if (specifier.startsWith('#')) {
    if (own?.packageJson.imports == null) fail(`No "imports" to map ${specifier}`)
    const hit = packageTarget(context, own.rootPath, importsTarget(own.packageJson.imports, specifier, context.conditions))
    if (hit !== null) return hit
  }
  // The importer's own package may redirect a bare specifier: to a path in
  // it, to another specifier, or to nothing.
  const redirected = own === null ? null : packages.match(specifier, own.packageJson)
  if (redirected === false) return EMPTY
  if (redirected !== null && RELATIVE.test(redirected)) return resolveModulePath(context, resolvePath(own.rootPath, redirected)) ?? fail(`Cannot resolve ${redirected}`)
  if (redirected !== null && (posix.isAbsolute(redirected) || win32.isAbsolute(redirected))) fail(`"browser" redirects ${specifier} to an absolute path`)
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
  const hit = extra === undefined ? null : fromTargetPath(context, join(extra, bare.posixSubpath))
  return hit ?? fail(`Cannot find ${specifier}`)
}

// Every node_modules from the origin's directory up, then each of
// `nodeModulesPaths` not among them; those alone without hierarchical lookup.
function* nodeModulesDirs({ origin, nodeModulesPaths, disableHierarchicalLookup }) {
  const visited = new Set()
  if (!disableHierarchicalLookup) {
    for (const dir of selfAndAncestors(dirname(origin))) {
      const nodeModules = dir.endsWith(sep) ? `${dir}node_modules` : `${dir}${sep}node_modules`
      visited.add(nodeModules)
      yield nodeModules
    }
  }
  for (const nodeModules of nodeModulesPaths) if (!visited.has(nodeModules)) yield nodeModules
}

function* selfAndAncestors(dir) {
  yield dir
  if (dirname(dir) !== dir) yield* selfAndAncestors(dirname(dir))
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
    const subpath = pkg.packageRelativePath === '' ? '.' : `./${toPosix(pkg.packageRelativePath)}`
    const hit = packageTarget(context, pkg.rootPath, exportsTarget(pkg.packageJson.exports, subpath, context.conditions))
    if (hit !== null) return hit
  }
  return resolveModulePath(context, candidate)
}

// The file a package map's target names in the package at `rootPath`, no
// extension or index probed: an asset with its scale variants, else the file
// itself; null where it names none, Metro's cue to resolve by files instead.
function packageTarget(context, rootPath, target) {
  if (target === null) return null
  const filePath = join(rootPath, target)
  const files = isAssetFile(filePath, context.assetExts) ? assetFiles(context.host, filePath, context.assetResolutions) : null
  if (files !== null) return { type: 'assetFiles', filePaths: files }
  return context.host.isFile(filePath) ? sourceFile(context, filePath) : null
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
  return resolveFile(context, dirname(main), basename(main)) ?? resolveFile(context, main, 'index') ?? fail(`No main module in ${packagePath}`)
}

// `fileName` in `dirPath` as an asset, at its scales, where its extension is
// an asset's; else as a source file: the name itself, then for each source
// extension the platform's file, the native one, the plain one, each through
// its package's redirects.
function resolveFile(context, dirPath, fileName) {
  const { assetExts, host, platform, preferNativePlatform, sourceExts } = context
  if (isAssetFile(fileName, assetExts)) {
    const files = assetFiles(host, join(dirPath, fileName), context.assetResolutions)
    return files === null ? null : { type: 'assetFiles', filePaths: files }
  }
  const prefix = join(dirPath, fileName)
  if (host.isFile(prefix)) return sourceFile(context, prefix)
  const suffixes = [...(platform === null ? [] : [`.${platform}`]), ...(preferNativePlatform ? ['.native'] : []), '']
  for (const ext of sourceExts) {
    for (const suffix of suffixes) {
      const candidate = context.packages.redirect(`${prefix}${suffix}.${ext}`)
      if (candidate === false) return EMPTY
      if (host.isFile(candidate)) return sourceFile(context, candidate)
    }
  }
  return null
}

const sourceFile = ({ host }, filePath) => ({ type: 'sourceFile', filePath: host.realpath(filePath) })

// A bare specifier's package name, its first segment, and its subpath (`.`
// or `./x`), as Metro splits one.
function parseBareSpecifier(specifier) {
  const normalizedSpecifier = sep === '/' ? specifier : specifier.replaceAll('\\', '/')
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
