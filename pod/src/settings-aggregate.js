// The build settings of an app target's Pods target, as BuildSettings::AggregateTargetSettings has them: what
// the app's own target is built and linked with, by the .xcconfig its configuration is based on.

import { publicSearchPaths } from './headers.js'
import { BUILD_DIR, XCFRAMEWORKS_DIR, configOf, mergedXcconfigs, uniqueSorted } from './settings.js'
import { compareVersions } from './targets.js'

const NAMES = [
  'PODS_BUILD_DIR', 'PODS_CONFIGURATION_BUILD_DIR', 'PODS_XCFRAMEWORKS_BUILD_DIR', 'USE_RECURSIVE_SCRIPT_INPUTS_IN_SCRIPT_PHASES', 'CODE_SIGN_IDENTITY',
  'FRAMEWORK_SEARCH_PATHS', 'GCC_PREPROCESSOR_DEFINITIONS', 'OTHER_CFLAGS', 'OTHER_MODULE_VERIFIER_FLAGS', 'OTHER_SWIFT_FLAGS',
  'CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER', 'OTHER_LDFLAGS', 'PODS_PODFILE_DIR_PATH', 'PODS_ROOT', 'LIBRARY_SEARCH_PATHS', 'HEADER_SEARCH_PATHS',
  'SWIFT_INCLUDE_PATHS', 'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES', 'EMBEDDED_CONTENT_CONTAINS_SWIFT', 'LD_RUNPATH_SEARCH_PATHS',
]

// BuildSettings#_ld_runpath_search_paths, of iOS.
function runpaths(aggregate, pods) {
  const dynamic = pods.some((pod) => !pod.static) || pods.some((pod) => pod.settings.vendored.dynamicFrameworks.length + pod.settings.vendored.dynamicLibraries.length > 0 || pod.settings.xcframeworks.some((one) => one.framework && one.dynamic))
  if (!dynamic) return undefined
  const paths = pods.some((pod) => pod.usesSwift) ? ['/usr/lib/swift'] : []
  paths.push("'@executable_path/Frameworks'", "'@loader_path/Frameworks'")
  if (aggregate.requiresHostTarget) paths.push("'@executable_path/../../Frameworks'")
  return [...new Set(paths)]
}

// The warnings of the pods that inhibit theirs, silenced in the app's build too.
function silenced(pods) {
  const headers = []
  const frameworks = []
  for (const pod of pods.filter((one) => one.inhibitWarnings)) {
    if (pod.framework && pod.shouldBuild) headers.push(pod.settings.frameworkHeaderSearchPath)
    else headers.push(...pod.settings.publicHeaderSearchPaths)
    frameworks.push(...pod.settings.frameworkSearchPathsToImport)
  }
  return [...[...new Set(headers)].flatMap((path) => ['-isystem', path]), ...[...new Set(frameworks)].flatMap((path) => ['-iframework', path])]
}

function settingsOf(aggregate, pods, sandbox) {
  const of = (pod) => pod.settings
  const moduleMaps = uniqueSorted(pods.map((pod) => of(pod).moduleMapFileToImport).filter((file) => file !== undefined))
  const usesSwift = pods.some((pod) => pod.usesSwift)
  const embedsSwift = !aggregate.requiresHostTarget && usesSwift
  const modern = aggregate.swiftVersion === undefined || compareVersions(aggregate.swiftVersion, '2.3') >= 0
  const headerPaths = aggregate.framework && pods.every((pod) => pod.shouldBuild) ? [] : publicSearchPaths(pods)
  headerPaths.push(...pods.filter((pod) => pod.framework && pod.shouldBuild).map((pod) => of(pod).frameworkHeaderSearchPath))
  headerPaths.push(...pods.flatMap((pod) => of(pod).xcframeworks).filter((one) => !one.framework && !one.dynamic).map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/Headers`))
  const libraries = uniqueSorted(pods.flatMap((pod) => of(pod).librariesToImport))
  const frameworks = uniqueSorted(pods.flatMap((pod) => of(pod).frameworksToImport))
  const weakFrameworks = uniqueSorted(pods.flatMap((pod) => of(pod).weakFrameworksToImport))
  const objc = pods.some((pod) => pod.static) || pods.some((pod) => of(pod).vendored.staticLibraries.length + of(pod).vendored.staticFrameworks.length > 0 || of(pod).xcframeworks.some((one) => one.framework && !one.dynamic))
  return {
    PODS_BUILD_DIR: '${BUILD_DIR}',
    PODS_CONFIGURATION_BUILD_DIR: '${PODS_BUILD_DIR}/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)',
    PODS_XCFRAMEWORKS_BUILD_DIR: '$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates',
    USE_RECURSIVE_SCRIPT_INPUTS_IN_SCRIPT_PHASES: 'YES',
    FRAMEWORK_SEARCH_PATHS: uniqueSorted(pods.flatMap((pod) => of(pod).frameworkSearchPathsToImport)),
    GCC_PREPROCESSOR_DEFINITIONS: ['COCOAPODS=1'],
    OTHER_CFLAGS: [...moduleMaps.map((file) => `-fmodule-map-file=${file}`), ...silenced(pods)],
    OTHER_MODULE_VERIFIER_FLAGS: pods.map((pod) => `-F${BUILD_DIR}/${pod.label}`),
    OTHER_SWIFT_FLAGS: usesSwift || moduleMaps.length > 0 ? ['-D', 'COCOAPODS', ...moduleMaps.flatMap((file) => ['-Xcc', `-fmodule-map-file=${file}`])] : undefined,
    CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: 'NO',
    OTHER_LDFLAGS: [...(objc ? ['-ObjC'] : []), ...libraries.map((name) => `-l"${name}"`), ...frameworks.flatMap((name) => ['-framework', `"${name}"`]), ...weakFrameworks.flatMap((name) => ['-weak_framework', `"${name}"`])],
    PODS_PODFILE_DIR_PATH: `\${SRCROOT}/${sandbox.podfileDir}`,
    PODS_ROOT: `\${SRCROOT}/${sandbox.podsDir}`,
    LIBRARY_SEARCH_PATHS: uniqueSorted(pods.flatMap((pod) => of(pod).librarySearchPathsToImport)),
    HEADER_SEARCH_PATHS: uniqueSorted(headerPaths),
    SWIFT_INCLUDE_PATHS: uniqueSorted(pods.flatMap((pod) => of(pod).swiftIncludePathsToImport)),
    ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: embedsSwift && modern ? 'YES' : undefined,
    EMBEDDED_CONTENT_CONTAINS_SWIFT: embedsSwift && !modern ? 'YES' : undefined,
    LD_RUNPATH_SEARCH_PATHS: runpaths(aggregate, pods),
  }
}

// The .xcconfig of `aggregate`, alike for each of the app's configurations, as each takes every pod. `sandbox`
// says where Pods/ and the lockfile are from the app's project.
export function aggregateConfig(aggregate, sandbox) {
  const pods = aggregate.podTargets
  const user = mergedXcconfigs(pods.flatMap((pod) => pod.consumers).map((consumer) => Object.fromEntries(Object.entries(consumer.user_target_xcconfig).filter(([key]) => key !== 'USE_HEADERMAP'))))
  return configOf(settingsOf(aggregate, pods, sandbox), NAMES, user)
}
