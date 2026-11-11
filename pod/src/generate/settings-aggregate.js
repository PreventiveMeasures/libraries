// The build settings of an app target's Pods target, BuildSettings::AggregateTargetSettings: what the app's own
// target builds and links with, by the .xcconfig its configuration is based on.

import { compareVersions } from '../order.js'
import { publicSearchPaths } from './headers.js'
import { BUILD_DIR, COMMON, XCFRAMEWORKS_DIR, configOf, linkerFlags, mergedXcconfigs, swiftFlags, uniqueSorted } from './settings.js'

// BuildSettings#_ld_runpath_search_paths, of iOS.
function runpaths(aggregate, pods) {
  const dynamic = pods.some((pod) => !pod.static || pod.settings.vendored.dynamicFrameworks.length + pod.settings.vendored.dynamicLibraries.length > 0 || pod.settings.xcframeworks.some((one) => one.framework && one.dynamic))
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
  const all = (key) => pods.flatMap((pod) => pod.settings[key])
  const moduleMaps = uniqueSorted(pods.map((pod) => pod.settings.moduleMapFileToImport).filter((file) => file !== undefined))
  const usesSwift = pods.some((pod) => pod.usesSwift)
  const embedsSwift = !aggregate.requiresHostTarget && usesSwift
  const modern = aggregate.swiftVersion === undefined || compareVersions(aggregate.swiftVersion, '2.3') >= 0
  // The public headers of every pod, whichever app target takes it; none where this one's are all frameworks.
  const headerPaths = aggregate.framework && pods.every((pod) => pod.shouldBuild) ? [] : publicSearchPaths(sandbox.pods)
  headerPaths.push(...pods.filter((pod) => pod.framework && pod.shouldBuild).map((pod) => pod.settings.frameworkHeaderSearchPath))
  headerPaths.push(...all('xcframeworks').filter((one) => !one.framework && !one.dynamic).map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/Headers`))
  const objc = pods.some((pod) => pod.static || pod.settings.vendored.staticLibraries.length + pod.settings.vendored.staticFrameworks.length > 0 || pod.settings.xcframeworks.some((one) => one.framework && !one.dynamic))
  return {
    ...COMMON,
    FRAMEWORK_SEARCH_PATHS: uniqueSorted(all('frameworkSearchPathsToImport')),
    OTHER_CFLAGS: [...moduleMaps.map((file) => `-fmodule-map-file=${file}`), ...silenced(pods)],
    OTHER_MODULE_VERIFIER_FLAGS: pods.map((pod) => `-F${BUILD_DIR}/${pod.label}`),
    OTHER_SWIFT_FLAGS: usesSwift || moduleMaps.length > 0 ? swiftFlags(moduleMaps) : undefined,
    OTHER_LDFLAGS: [...(objc ? ['-ObjC'] : []), ...linkerFlags(uniqueSorted(all('librariesToImport')), uniqueSorted(all('frameworksToImport')), uniqueSorted(all('weakFrameworksToImport')))],
    PODS_PODFILE_DIR_PATH: `\${SRCROOT}/${sandbox.podfileDir}`,
    PODS_ROOT: `\${SRCROOT}/${sandbox.podsDir}`,
    LIBRARY_SEARCH_PATHS: uniqueSorted(all('librarySearchPathsToImport')),
    HEADER_SEARCH_PATHS: uniqueSorted(headerPaths),
    SWIFT_INCLUDE_PATHS: uniqueSorted(all('swiftIncludePathsToImport')),
    ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: embedsSwift && modern ? 'YES' : undefined,
    EMBEDDED_CONTENT_CONTAINS_SWIFT: embedsSwift && !modern ? 'YES' : undefined,
    LD_RUNPATH_SEARCH_PATHS: runpaths(aggregate, pods),
  }
}

// The .xcconfig of `aggregate`, alike for each of the app's configurations. `sandbox` says where Pods/ and the
// Podfile are from the app's project, and has every pod target.
export function aggregateConfig(aggregate, sandbox) {
  const pods = aggregate.podTargets
  const user = mergedXcconfigs(pods.flatMap((pod) => pod.consumers).map((consumer) => Object.fromEntries(Object.entries(consumer.user_target_xcconfig).filter(([key]) => key !== 'USE_HEADERMAP'))))
  return configOf(settingsOf(aggregate, pods, sandbox), user)
}
