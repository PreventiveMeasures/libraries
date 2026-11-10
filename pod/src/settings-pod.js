// A pod target's build settings, as BuildSettings::PodTargetSettings has them for its library: what its
// .xcconfig says, and what a target that depends on it, or links it, imports of it.

import { basename, extname, posix } from 'node:path'

import { isDynamic, readXcframework } from './binaries.js'
import { privateSearchPaths, publicSearchPaths } from './headers.js'
import { BUILD_DIR, XCFRAMEWORKS_DIR, configOf, lazy, mergedXcconfigs, sorted, uniqueSorted } from './settings.js'
import { byBytes } from './xcconfig.js'

const NAMES = [
  'PODS_BUILD_DIR', 'PODS_CONFIGURATION_BUILD_DIR', 'PODS_XCFRAMEWORKS_BUILD_DIR', 'USE_RECURSIVE_SCRIPT_INPUTS_IN_SCRIPT_PHASES', 'CODE_SIGN_IDENTITY',
  'FRAMEWORK_SEARCH_PATHS', 'GCC_PREPROCESSOR_DEFINITIONS', 'OTHER_CFLAGS', 'OTHER_MODULE_VERIFIER_FLAGS', 'OTHER_SWIFT_FLAGS',
  'CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER', 'OTHER_LDFLAGS', 'PODS_ROOT', 'PODS_TARGET_SRCROOT', 'PODS_DEVELOPMENT_LANGUAGE',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS', 'LIBRARY_SEARCH_PATHS', 'HEADER_SEARCH_PATHS', 'SWIFT_INCLUDE_PATHS', 'LD_RUNPATH_SEARCH_PATHS', 'SKIP_INSTALL',
  'PRODUCT_BUNDLE_IDENTIFIER', 'CONFIGURATION_BUILD_DIR', 'APPLICATION_EXTENSION_API_ONLY', 'BUILD_LIBRARY_FOR_DISTRIBUTION',
]

const stem = (path) => basename(path, extname(path))
const linkerName = (path) => stem(path).replace(/^lib/u, '')
const DEVELOPER_FRAMEWORKS = '$(PLATFORM_DIR)/Developer/Library/Frameworks'
const developerPaths = (frameworks) => (frameworks.includes('XCTest') || frameworks.includes('SenTestingKit') ? [DEVELOPER_FRAMEWORKS] : [])
const intermediate = (xcframework) => `${XCFRAMEWORKS_DIR}/${xcframework.targetName}`

// PodTarget#framework_paths and PodTargetInstaller.dsym_paths: the symbols that come with what a pod vends as
// dynamic, each from Pods/. A .dSYM beside a library or a framework, of its whole name; those of a directory
// <name>.dSYMs beside an .xcframework; and the .bcsymbolmap files beside a library or a framework.
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

// What a pod vends as it is: its frameworks and libraries, each static or dynamic, and its .xcframeworks; and
// of each spec what is dynamic and is neither built nor in an .xcframework, its libraries before its frameworks.
function vendored(target) {
  const full = (path) => posix.join(target.dir, path)
  const fromSandbox = (path) => `\${PODS_ROOT}/${posix.join(target.sandboxPath, posix.dirname(path))}`
  const frameworks = target.accessors.flatMap((accessor) => accessor.vendoredFrameworks.filter((path) => extname(path) !== '.xcframework'))
  const dynamicFrameworks = frameworks.filter((path) => isDynamic(posix.join(full(path), stem(path))))
  const libraries = target.accessors.flatMap((accessor) => accessor.vendoredLibraries)
  const dynamicLibraries = libraries.filter((path) => isDynamic(full(path)))
  const artifacts = target.accessors.map((accessor) => [...accessor.vendoredLibraries.filter((path) => dynamicLibraries.includes(path)), ...accessor.vendoredFrameworks.filter((path) => dynamicFrameworks.includes(path))])
  return {
    artifacts,
    ...symbolsOf(target, artifacts),
    xcframeworks: target.accessors.flatMap((accessor) => accessor.vendoredXcframeworks.map((path) => readXcframework(full(path), accessor.spec.name, target.where))),
    frameworkDirs: target.accessors.flatMap((accessor) => accessor.vendoredFrameworks).map(fromSandbox),
    staticFrameworks: frameworks.filter((path) => !dynamicFrameworks.includes(path)),
    dynamicFrameworks,
    staticLibraries: libraries.filter((path) => !dynamicLibraries.includes(path)),
    dynamicLibraries,
    staticLibraryDirs: libraries.filter((path) => !dynamicLibraries.includes(path)).map(fromSandbox),
    dynamicLibraryDirs: dynamicLibraries.map(fromSandbox),
  }
}

// `targets` are all the pod targets, whose public headers a target's search paths are of.
export function podSettings(target, targets) {
  const of = (other) => other.settings
  const builtDynamic = target.shouldBuild && !target.static
  const ownBuildDir = `${BUILD_DIR}/${target.label}`
  const dependents = target.recursiveDependencies
  const consumers = target.consumers
  return lazy({
    vendored: () => vendored(target),
    xcframeworks: (my) => my.vendored.xcframeworks,
    consumerFrameworks: () => consumers.flatMap((consumer) => consumer.frameworks),
    staticXcframeworkNames: (my) => [...new Set(my.xcframeworks.filter((one) => one.framework && !one.dynamic).map((one) => one.name))],
    staticFrameworksToImport: (my) => [
      ...(builtDynamic ? [] : [...my.vendored.staticFrameworks.map(stem), ...my.staticXcframeworkNames]),
      ...(target.shouldBuild && target.framework && target.static ? [target.productBasename] : []),
    ],
    dynamicFrameworksToImport: (my) => [
      ...my.vendored.dynamicFrameworks.map(stem),
      ...new Set(my.xcframeworks.filter((one) => one.framework && one.dynamic).map((one) => one.name)),
      ...(target.shouldBuild && target.framework && !target.static ? [target.productBasename] : []),
      ...my.consumerFrameworks,
    ],
    frameworksToImport: (my) => uniqueSorted([...my.staticFrameworksToImport, ...my.dynamicFrameworksToImport]),
    weakFrameworksToImport: () => uniqueSorted(consumers.flatMap((consumer) => consumer.weak_frameworks)),
    frameworks: (my) => {
      if (target.static) return []
      const imported = target.shouldBuild
        ? [...my.vendored.staticFrameworks.map(stem), ...my.staticXcframeworkNames, ...target.dependencies.flatMap((other) => of(other).dynamicFrameworksToImport)]
        : dependents.filter((other) => !other.shouldBuild).flatMap((other) => of(other).dynamicFrameworksToImport)
      return uniqueSorted([...my.consumerFrameworks, ...imported])
    },
    weakFrameworks: (my) => (target.static ? [] : [...my.weakFrameworksToImport, ...dependents.flatMap((other) => of(other).weakFrameworksToImport)]),
    vendoredFrameworkSearchPaths: (my) => [...my.vendored.frameworkDirs, ...new Set(my.xcframeworks.filter((one) => one.framework).map(intermediate))],
    frameworkSearchPathsToImport: (my) => [...developerPaths(my.consumerFrameworks), ...my.vendoredFrameworkSearchPaths, ...(target.framework && target.shouldBuild ? [ownBuildDir] : [])],
    frameworkHeaderSearchPath: () => (target.framework ? `${ownBuildDir}/${target.productName}/Headers` : undefined),
    staticLibrarySearchPaths: (my) => [...my.vendored.staticLibraryDirs, ...my.xcframeworks.filter((one) => !one.framework && !one.dynamic).map(intermediate)],
    dynamicLibrarySearchPaths: (my) => [...my.vendored.dynamicLibraryDirs, ...my.xcframeworks.filter((one) => !one.framework && one.dynamic).map(intermediate)],
    xcframeworkLibraries: (my) => [...new Set(my.xcframeworks.filter((one) => !one.framework && !one.dynamic).map((one) => linkerName(one.slices[0].binary)))],
    staticLibrariesToImport: (my) => [
      ...(builtDynamic ? [] : [...my.vendored.staticLibraries.map(linkerName), ...my.xcframeworkLibraries]),
      ...(target.shouldBuild && !target.framework && target.static ? [target.productBasename] : []),
    ],
    dynamicLibrariesToImport: (my) => [...my.vendored.dynamicLibraries.map(linkerName), ...consumers.flatMap((consumer) => consumer.libraries)],
    librariesToImport: (my) => uniqueSorted([...my.staticLibrariesToImport, ...my.dynamicLibrariesToImport]),
    libraries: (my) => (target.static ? [] : uniqueSorted([...my.vendored.staticLibraries.map(linkerName), ...my.librariesToImport, ...my.xcframeworkLibraries])),
    librarySearchPathsToImport: (my) => [
      ...my.staticLibrarySearchPaths,
      ...my.dynamicLibrarySearchPaths,
      ...(target.usesSwift ? ['/usr/lib/swift', '${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}'] : []),
      ...(target.framework || !target.shouldBuild ? [] : [ownBuildDir]),
    ],
    // Whether a spec says no module map is written is not asked, as CocoaPods does not ask it: a library that
    // defines a module has the path of one given to those that import it.
    moduleMapFileToImport: () => {
      if (!target.shouldBuild || target.framework || !target.definesModule) return undefined
      return target.usesSwift ? `${ownBuildDir}/${target.moduleName}.modulemap` : `\${PODS_ROOT}/${target.moduleMapLink}`
    },
    moduleMapFiles: () => sorted(dependents.map((other) => of(other).moduleMapFileToImport).filter((file) => file !== undefined)),
    swiftIncludePathsToImport: () => (target.usesSwift && !target.framework ? [ownBuildDir] : []),
    publicHeaderSearchPaths: () => sorted(headerSearchPaths(target, targets, false)),
    merged: () => mergedXcconfigs(consumers.map((consumer) => consumer.pod_target_xcconfig)),
    config: (my) => configOf(settingsOf(target, targets, my), NAMES, my.merged),
  })
}

// PodTarget#header_search_paths.
function headerSearchPaths(target, targets, includePrivate) {
  const paths = includePrivate ? privateSearchPaths(target) : []
  paths.push(...publicSearchPaths(targets, target.name, target.definesModule && target.plainHeaders))
  for (const other of target.recursiveDependencies) paths.push(...publicSearchPaths(targets, other.name, target.definesModule && other.plainHeaders))
  return [...new Set(paths)]
}

function swiftFlags(target, my) {
  if (!target.usesSwift) return undefined
  const flags = ['-D', 'COCOAPODS', ...my.moduleMapFiles.flatMap((file) => ['-Xcc', `-fmodule-map-file=${file}`])]
  if (target.inhibitWarnings) flags.push('-suppress-warnings')
  if (!target.framework && target.definesModule) flags.push('-import-underlying-module', '-Xcc', '-fmodule-map-file=${SRCROOT}/${MODULEMAP_FILE}')
  return flags
}

// The settings of the .xcconfig, by their names.
function settingsOf(target, targets, my) {
  const dependents = target.recursiveDependencies
  const ownBuildDir = `${BUILD_DIR}/${target.label}`
  const xcframeworkHeaders = [...my.xcframeworks, ...dependents.flatMap((other) => other.settings.xcframeworks)].filter((one) => !one.framework && !one.dynamic).map((one) => `${intermediate(one)}/Headers`)
  const frameworkSearchPaths = [...developerPaths([...my.frameworks, ...my.weakFrameworks]), ...dependents.flatMap((other) => other.settings.frameworkSearchPathsToImport), ...my.frameworkSearchPathsToImport]
  const librarySearchPaths = target.static ? [] : [...my.librarySearchPathsToImport, ...dependents.flatMap((other) => other.settings.dynamicLibrarySearchPaths)]
  return {
    PODS_BUILD_DIR: '${BUILD_DIR}',
    PODS_CONFIGURATION_BUILD_DIR: '${PODS_BUILD_DIR}/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)',
    PODS_XCFRAMEWORKS_BUILD_DIR: '$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates',
    USE_RECURSIVE_SCRIPT_INPUTS_IN_SCRIPT_PHASES: 'YES',
    FRAMEWORK_SEARCH_PATHS: uniqueSorted(frameworkSearchPaths).filter((path) => path !== ownBuildDir),
    GCC_PREPROCESSOR_DEFINITIONS: ['COCOAPODS=1'],
    OTHER_CFLAGS: my.moduleMapFiles.map((file) => `-fmodule-map-file=${file}`),
    OTHER_MODULE_VERIFIER_FLAGS: [],
    OTHER_SWIFT_FLAGS: swiftFlags(target, my),
    CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: 'NO',
    OTHER_LDFLAGS: [...my.libraries.map((name) => `-l"${name}"`), ...my.frameworks.flatMap((name) => ['-framework', `"${name}"`]), ...my.weakFrameworks.flatMap((name) => ['-weak_framework', `"${name}"`])],
    PODS_ROOT: '${SRCROOT}',
    PODS_TARGET_SRCROOT: `\${PODS_ROOT}/${target.sandboxPath}`,
    PODS_DEVELOPMENT_LANGUAGE: '${DEVELOPMENT_LANGUAGE}',
    SYSTEM_FRAMEWORK_SEARCH_PATHS: [],
    LIBRARY_SEARCH_PATHS: uniqueSorted(librarySearchPaths).filter((path) => path !== ownBuildDir),
    HEADER_SEARCH_PATHS: sorted([...headerSearchPaths(target, targets, true), ...xcframeworkHeaders]),
    SWIFT_INCLUDE_PATHS: uniqueSorted([...dependents.flatMap((other) => other.settings.swiftIncludePathsToImport), ...dependents.flatMap((other) => other.settings.staticLibrarySearchPaths)]),
    SKIP_INSTALL: 'YES',
    PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.${PRODUCT_NAME:rfc1034identifier}',
    CONFIGURATION_BUILD_DIR: ownBuildDir,
    APPLICATION_EXTENSION_API_ONLY: target.extensionApiOnly ? 'YES' : undefined,
  }
}
