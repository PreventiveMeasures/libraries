// A pod target's build settings, BuildSettings::PodTargetSettings of its library: its .xcconfig, and what a
// target that depends on it or links it imports of it.

import { basename, extname, posix } from 'node:path'

import { byBytes } from '../order.js'
import { isDynamic, readXcframework } from './binaries.js'
import { privateSearchPaths, publicSearchPaths } from './headers.js'
import { BUILD_DIR, COMMON, XCFRAMEWORKS_DIR, configOf, lazy, linkerFlags, mergedXcconfigs, sorted, swiftFlags, uniqueSorted } from './settings.js'

const stem = (path) => basename(path, extname(path))
const linkerName = (path) => stem(path).replace(/^lib/u, '')
const DEVELOPER_FRAMEWORKS = '$(PLATFORM_DIR)/Developer/Library/Frameworks'
const developerPaths = (frameworks) => (frameworks.includes('XCTest') || frameworks.includes('SenTestingKit') ? [DEVELOPER_FRAMEWORKS] : [])
const intermediate = (xcframework) => `${XCFRAMEWORKS_DIR}/${xcframework.targetName}`

// PodTarget#framework_paths and PodTargetInstaller.dsym_paths, from Pods/: the .dSYM beside each vended dynamic
// library or framework, those in a <name>.dSYMs beside an .xcframework, and the .bcsymbolmap files beside them.
function symbolsOf(target, artifacts) {
  const { files, dirs } = target.list
  const there = new Set([...files, ...dirs])
  const inDir = (dir, extension) => [...there].filter((path) => posix.dirname(path) === dir && path.endsWith(extension) && !posix.basename(path).startsWith('.')).sort(byBytes)
  const fromPods = (path) => `\${PODS_ROOT}/${posix.join(target.sandboxPath, path)}`
  const beside = artifacts.flat().map((path) => `${path}.dSYM`).filter((path) => there.has(path))
  const ofXcframeworks = target.accessors.flatMap((accessor) => accessor.vendoredXcframeworks).flatMap((path) => {
    const dir = posix.join(posix.dirname(path), `${basename(path, '.xcframework')}.dSYMs`)
    return dirs.includes(dir) ? inDir(dir, '.dSYM') : []
  })
  const maps = artifacts.flat().flatMap((path) => inDir(posix.dirname(path), '.bcsymbolmap').filter((one) => files.includes(one)))
  return { dsyms: [...beside, ...ofXcframeworks].map(fromPods), bcsymbolmaps: [...new Set(maps)].map(fromPods) }
}

// What a pod vends built: its frameworks and libraries, static or dynamic, and its .xcframeworks; and of each spec
// the dynamic ones outside an .xcframework, libraries first.
function vendored(target) {
  const full = (path) => posix.join(target.dir, path)
  const fromSandbox = (path) => `\${PODS_ROOT}/${posix.join(target.sandboxPath, posix.dirname(path))}`
  const frameworks = target.accessors.flatMap((accessor) => accessor.vendoredFrameworks.filter((path) => extname(path) !== '.xcframework'))
  const dynamicFrameworks = frameworks.filter((path) => isDynamic(posix.join(full(path), stem(path))))
  const libraries = target.accessors.flatMap((accessor) => accessor.vendoredLibraries)
  const dynamicLibraries = libraries.filter((path) => isDynamic(full(path)))
  const staticLibraries = libraries.filter((path) => !dynamicLibraries.includes(path))
  const artifacts = target.accessors.map((accessor) => [...accessor.vendoredLibraries.filter((path) => dynamicLibraries.includes(path)), ...accessor.vendoredFrameworks.filter((path) => dynamicFrameworks.includes(path))])
  return {
    artifacts,
    ...symbolsOf(target, artifacts),
    xcframeworks: target.accessors.flatMap((accessor) => accessor.vendoredXcframeworks.map((path) => readXcframework(full(path), accessor.spec.name, target.where))),
    frameworkDirs: target.accessors.flatMap((accessor) => accessor.vendoredFrameworks).map(fromSandbox),
    staticFrameworks: frameworks.filter((path) => !dynamicFrameworks.includes(path)),
    dynamicFrameworks,
    staticLibraries,
    dynamicLibraries,
    staticLibraryDirs: staticLibraries.map(fromSandbox),
    dynamicLibraryDirs: dynamicLibraries.map(fromSandbox),
  }
}

// The names of the .xcframeworks of a kind, a library's as it is linked.
const xcframeworkNames = (xcframeworks, framework, dynamic) => [...new Set(xcframeworks.filter((one) => one.framework === framework && one.dynamic === dynamic).map((one) => (framework ? one.name : linkerName(one.slices[0].binary))))]
const frameworksOf = (target) => target.consumers.flatMap((consumer) => consumer.frameworks)

// What other targets read of a target's, each computed when first read. `targets` are all the pod targets.
export function podSettings(target, targets) {
  const builtDynamic = target.shouldBuild && !target.static
  const ownBuildDir = `${BUILD_DIR}/${target.label}`
  return lazy({
    vendored: () => vendored(target),
    xcframeworks: (my) => my.vendored.xcframeworks,
    dynamicFrameworksToImport: (my) => [
      ...my.vendored.dynamicFrameworks.map(stem),
      ...xcframeworkNames(my.xcframeworks, true, true),
      ...(target.shouldBuild && target.framework && !target.static ? [target.productBasename] : []),
      ...frameworksOf(target),
    ],
    frameworksToImport: (my) => uniqueSorted([
      ...(builtDynamic ? [] : [...my.vendored.staticFrameworks.map(stem), ...xcframeworkNames(my.xcframeworks, true, false)]),
      ...(target.shouldBuild && target.framework && target.static ? [target.productBasename] : []),
      ...my.dynamicFrameworksToImport,
    ]),
    weakFrameworksToImport: () => uniqueSorted(target.consumers.flatMap((consumer) => consumer.weak_frameworks)),
    frameworkSearchPathsToImport: (my) => [
      ...developerPaths(frameworksOf(target)),
      ...my.vendored.frameworkDirs,
      ...new Set(my.xcframeworks.filter((one) => one.framework).map(intermediate)),
      ...(target.framework && target.shouldBuild ? [ownBuildDir] : []),
    ],
    frameworkHeaderSearchPath: () => (target.framework ? `${ownBuildDir}/${target.productName}/Headers` : undefined),
    staticLibrarySearchPaths: (my) => [...my.vendored.staticLibraryDirs, ...my.xcframeworks.filter((one) => !one.framework && !one.dynamic).map(intermediate)],
    dynamicLibrarySearchPaths: (my) => [...my.vendored.dynamicLibraryDirs, ...my.xcframeworks.filter((one) => !one.framework && one.dynamic).map(intermediate)],
    librariesToImport: (my) => uniqueSorted([
      ...(builtDynamic ? [] : [...my.vendored.staticLibraries.map(linkerName), ...xcframeworkNames(my.xcframeworks, false, false)]),
      ...(target.shouldBuild && !target.framework && target.static ? [target.productBasename] : []),
      ...my.vendored.dynamicLibraries.map(linkerName),
      ...target.consumers.flatMap((consumer) => consumer.libraries),
    ]),
    librarySearchPathsToImport: (my) => [
      ...my.staticLibrarySearchPaths,
      ...my.dynamicLibrarySearchPaths,
      ...(target.usesSwift ? ['/usr/lib/swift', '${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}'] : []),
      ...(target.framework || !target.shouldBuild ? [] : [ownBuildDir]),
    ],
    // CocoaPods does not ask whether a spec says no module map is written: a library that defines a module gives
    // importers the path of one.
    moduleMapFileToImport: () => {
      if (!target.shouldBuild || target.framework || !target.definesModule) return undefined
      return target.usesSwift ? `${ownBuildDir}/${target.moduleName}.modulemap` : `\${PODS_ROOT}/${target.moduleMapLink}`
    },
    swiftIncludePathsToImport: () => (target.usesSwift && !target.framework ? [ownBuildDir] : []),
    publicHeaderSearchPaths: () => sorted(headerSearchPaths(target, targets, false)),
    merged: () => mergedXcconfigs(target.consumers.map((consumer) => consumer.pod_target_xcconfig)),
    config: (my) => configOf(settingsOf(target, targets, my), my.merged),
  })
}

// PodTarget#header_search_paths.
function headerSearchPaths(target, targets, includePrivate) {
  const paths = includePrivate ? privateSearchPaths(target) : []
  paths.push(...publicSearchPaths(targets, target.name, target.definesModule && target.plainHeaders))
  for (const other of target.recursiveDependencies) paths.push(...publicSearchPaths(targets, other.name, target.definesModule && other.plainHeaders))
  return [...new Set(paths)]
}

function swiftFlagsOf(target, moduleMaps) {
  if (!target.usesSwift) return undefined
  const flags = swiftFlags(moduleMaps)
  if (target.inhibitWarnings) flags.push('-suppress-warnings')
  if (!target.framework && target.definesModule) flags.push('-import-underlying-module', '-Xcc', '-fmodule-map-file=${SRCROOT}/${MODULEMAP_FILE}')
  return flags
}

function settingsOf(target, targets, my) {
  const dependents = target.recursiveDependencies
  const ownBuildDir = `${BUILD_DIR}/${target.label}`
  const imported = target.shouldBuild
    ? [...my.vendored.staticFrameworks.map(stem), ...xcframeworkNames(my.xcframeworks, true, false), ...target.dependencies.flatMap((other) => other.settings.dynamicFrameworksToImport)]
    : dependents.filter((other) => !other.shouldBuild).flatMap((other) => other.settings.dynamicFrameworksToImport)
  const frameworks = target.static ? [] : uniqueSorted([...frameworksOf(target), ...imported])
  const weakFrameworks = target.static ? [] : [...my.weakFrameworksToImport, ...dependents.flatMap((other) => other.settings.weakFrameworksToImport)]
  const libraries = target.static ? [] : uniqueSorted([...my.vendored.staticLibraries.map(linkerName), ...my.librariesToImport, ...xcframeworkNames(my.xcframeworks, false, false)])
  const moduleMaps = sorted(dependents.map((other) => other.settings.moduleMapFileToImport).filter((file) => file !== undefined))
  const xcframeworkHeaders = [...my.xcframeworks, ...dependents.flatMap((other) => other.settings.xcframeworks)].filter((one) => !one.framework && !one.dynamic).map((one) => `${intermediate(one)}/Headers`)
  const frameworkSearchPaths = [...developerPaths([...frameworks, ...weakFrameworks]), ...dependents.flatMap((other) => other.settings.frameworkSearchPathsToImport), ...my.frameworkSearchPathsToImport]
  const librarySearchPaths = target.static ? [] : [...my.librarySearchPathsToImport, ...dependents.flatMap((other) => other.settings.dynamicLibrarySearchPaths)]
  return {
    ...COMMON,
    FRAMEWORK_SEARCH_PATHS: uniqueSorted(frameworkSearchPaths).filter((path) => path !== ownBuildDir),
    OTHER_CFLAGS: moduleMaps.map((file) => `-fmodule-map-file=${file}`),
    OTHER_MODULE_VERIFIER_FLAGS: [],
    OTHER_SWIFT_FLAGS: swiftFlagsOf(target, moduleMaps),
    OTHER_LDFLAGS: linkerFlags(libraries, frameworks, weakFrameworks),
    PODS_ROOT: '${SRCROOT}',
    PODS_TARGET_SRCROOT: `\${PODS_ROOT}/${target.sandboxPath}`,
    PODS_DEVELOPMENT_LANGUAGE: '${DEVELOPMENT_LANGUAGE}',
    SYSTEM_FRAMEWORK_SEARCH_PATHS: [],
    LIBRARY_SEARCH_PATHS: uniqueSorted(librarySearchPaths).filter((path) => path !== ownBuildDir),
    HEADER_SEARCH_PATHS: sorted([...headerSearchPaths(target, targets, true), ...xcframeworkHeaders]),
    SWIFT_INCLUDE_PATHS: uniqueSorted([...dependents.flatMap((other) => other.settings.swiftIncludePathsToImport), ...dependents.flatMap((other) => other.settings.staticLibrarySearchPaths)]),
    // Inherited alone, so that a spec's own comes after `$(inherited)`.
    LD_RUNPATH_SEARCH_PATHS: undefined,
    SKIP_INSTALL: 'YES',
    PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.${PRODUCT_NAME:rfc1034identifier}',
    CONFIGURATION_BUILD_DIR: ownBuildDir,
    APPLICATION_EXTENSION_API_ONLY: target.extensionApiOnly ? 'YES' : undefined,
  }
}
