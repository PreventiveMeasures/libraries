// React Native's part of reading a podspec: what a Podfile's use_react_native! leaves in the environment, and
// what install_modules_dependencies, scripts/react_native_pods.rb's, does to a specification. Each is a port of
// one version's own Ruby, and is had only of the versions whose Ruby is that, word for word, which are families
// by the minor version each begins at: 78, every 0.78; 83, every 0.83; 85, every 0.85 and 0.86; 88, every 0.88.
// Of another version nothing is known, and a podspec that needs it is refused.

import { addDependency, setAttribute } from './podspec-json.js'

// Helpers::Constants: folly's version and flags, the C++ standard, and the least iOS.
const FOLLY = ['2024.11.18.00', '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32']
const CXX = 'c++20'
const VALUES = { min_ios_version_supported: '15.1' }
// The variables use_react_native! sets from what the Podfile gave it, which no lockfile says.
const PODFILE = new Set(['APP_PATH', 'REACT_NATIVE_PATH'])

// The pods whose frameworks' headers a module is given the paths of, where pods are frameworks: each with the
// family it is given since, and the directories of its headers given besides.
const FRAMEWORKS = [
  [78, 'React-graphics', 'react/renderer/graphics/platform/ios'], [78, 'React-Fabric', 'react/renderer/components/view/platform/cxx'], [78, 'React-FabricImage'],
  [88, 'React-FabricComponents'], [88, 'React-Mapbuffer'], [88, 'React-RCTFBReactNativeSpec'], [78, 'ReactCommon', 'react/nativemodule/core'], [83, 'React-runtimeexecutor', 'platform/ios'],
  [78, 'React-NativeModulesApple'], [78, 'React-RCTFabric'], [78, 'React-utils'], [78, 'React-featureflags'], [78, 'React-debug'], [78, 'React-ImageManager'], [78, 'React-rendererdebug'],
  [83, 'React-renderercss'], [88, 'React-cxxstableapi'],
]
// What a module depends on in every family, between React-Core and its engine; 88 has the bridging as a pod.
const MODULES = ['React-RCTFabric', 'ReactCodegen', 'RCTRequired', 'RCTTypeSafety', 'ReactCommon/turbomodule/bridging', 'ReactCommon/turbomodule/core', 'React-NativeModulesApple', 'Yoga', 'React-Fabric', 'React-graphics', 'React-utils', 'React-featureflags', 'React-debug', 'React-ImageManager', 'React-rendererdebug']
const THIRD_PARTY = ['glog', 'boost', 'DoubleConversion', 'fast_float', 'fmt', 'RCT-Folly', 'SocketRocket']
const THIRD_PARTY_PATHS = ['glog', 'boost', 'DoubleConversion', 'fast_float/include', 'fmt/include', 'SocketRocket', 'RCT-Folly'].map((one) => `$(PODS_ROOT)/${one}`)
const OVERLAY = '$(PODS_ROOT)/React-Core-prebuilt/React-VFS.yaml'

const isText = (value) => typeof value === 'string'
// A string split as Ruby's split(" ") splits it: at its runs of whitespace.
const words = (value) => value.split(/[ \t\n\v\f\r]+/u).filter((word) => word !== '')

// ReactNativePodsUtils.create_header_search_path_for_frameworks, of each pod `family` has: where the headers
// of its framework are, and each directory given besides in them; the pod's own directory where the core is
// prebuilt, and is no framework.
function frameworkPaths(family, prebuilt) {
  return FRAMEWORKS.filter(([since]) => since <= family).flatMap(([, pod, ...extra]) => {
    const base = prebuilt ? `\${PODS_ROOT}/${pod}` : `\${PODS_CONFIGURATION_BUILD_DIR}/${pod}/${pod === 'React-RCTFabric' ? 'RCTFabric' : pod.replace('-', '_')}.framework/Headers`
    return [base, ...extra.map((one) => `${base}/${one}`)].map((path) => `"${path}"`)
  })
}

// The pod_target_xcconfig a helper reads of a specification: the specification's own, as Specification#to_hash
// gives it, so that a change to it is a change to the specification; a new one where it has none.
function configOf(spec, refuse) {
  const config = spec.attributes.get('pod_target_xcconfig') ?? new Map()
  return config instanceof Map ? config : refuse('`install_modules_dependencies` of a pod_target_xcconfig that is no hash')
}
// `spec.pod_target_xcconfig = config`: a copy of it is kept.
const store = (spec, config, refuse) => setAttribute(spec, 'pod_target_xcconfig', new Map(config), undefined, refuse)

// The compiler flags, with `computed` after those the specification has.
function addFlags(spec, computed, refuse) {
  const flags = spec.attributes.get('compiler_flags') ?? ''
  if (!isText(flags)) refuse('`install_modules_dependencies` of compiler flags that are no text')
  setAttribute(spec, 'compiler_flags', flags === '' ? computed.trim() : `${flags} ${computed}`, undefined, refuse)
}

// The header search paths, with `paths` after those the config has.
function addPaths(config, paths, refuse) {
  const current = config.get('HEADER_SEARCH_PATHS') ?? ''
  if (!isText(current) && (!Array.isArray(current) || current.length > 0)) refuse('`install_modules_dependencies` of header search paths that are no text')
  config.set('HEADER_SEARCH_PATHS', current.length === 0 ? paths.join(' ') : `${current} ${paths.join(' ')}`)
}

// ReactNativePodsUtils.add_flag_to_map_with_inheritance: `flag` in the setting `field`, which inherits.
function inherit(config, field, flag, refuse) {
  const value = config.get(field) ?? null
  if (value === null) config.set(field, `$(inherited)${flag}`)
  else if (isText(value)) {
    const added = value.includes(flag) ? value : value + flag
    config.set(field, added.includes('$(inherited)') ? added : `$(inherited) ${added}`)
  } else if (Array.isArray(value)) {
    if (!value.includes(flag)) value.push(flag)
    if (!value.includes('$(inherited)')) value.unshift('$(inherited)')
  } else refuse(`\`install_modules_dependencies\` of ${field} that is no text or list`)
}

// NewArchitectureHelper.install_modules_dependencies of 78.
function install78(spec, { env, refuse }) {
  const depend = (...args) => addDependency(spec, args, undefined, refuse)
  const newArch = [null, '1'].includes(env('RCT_NEW_ARCH_ENABLED'))
  const flags = ` ${newArch ? '-DRCT_NEW_ARCH_ENABLED=1 ' : ''}${FOLLY[1]}`
  const config = configOf(spec, refuse)
  const paths = ['"$(PODS_ROOT)/boost" "$(PODS_ROOT)/Headers/Private/Yoga"']
  if (env('USE_FRAMEWORKS') !== null) paths.push('"$(PODS_ROOT)/DoubleConversion"', '"$(PODS_ROOT)/fast_float/include"', '"$(PODS_ROOT)/fmt/include"', ...frameworkPaths(78, false))
  addFlags(spec, flags, refuse)
  addPaths(config, paths, refuse)
  config.set('CLANG_CXX_LANGUAGE_STANDARD', CXX)
  depend('React-Core')
  depend('RCT-Folly', FOLLY[0])
  depend('glog')
  inherit(config, 'OTHER_CPLUSPLUSFLAGS', flags, refuse)
  inherit(config, 'OTHER_SWIFT_FLAGS', newArch ? ' -DRCT_NEW_ARCH_ENABLED' : '', refuse)
  for (const name of [...MODULES, 'DoubleConversion', [null, '1'].includes(env('USE_HERMES')) ? 'hermes-engine' : 'React-jsi']) depend(name)
  store(spec, config, refuse)
}

// ReactNativeDependenciesUtils.append_header_search_paths, 88's: `paths`, quoted, after those the config has,
// but those it has already.
function appendPaths(config, paths, refuse) {
  const current = config.get('HEADER_SEARCH_PATHS') ?? null
  const added = paths.map((path) => `"${path}"`).filter((path) => current === null || !current.includes(path))
  if (current !== null && !isText(current) && !Array.isArray(current)) refuse('`install_modules_dependencies` of header search paths that are no text or list')
  config.set('HEADER_SEARCH_PATHS', isText(current) ? [current, ...added].join(' ') : [...(current ?? []), ...added])
}

// add_rn_third_party_dependencies: the pods React Native is built on, or the one they are prebuilt as, and
// where their headers are.
function thirdParty(family, spec, depend, { env, prebuilt, refuse }) {
  const config = configOf(spec, refuse)
  const current = config.get('HEADER_SEARCH_PATHS') ?? null
  for (const name of prebuilt.deps ? ['ReactNativeDependencies'] : [...THIRD_PARTY, ...(env('RCT_NEW_ARCH_ENABLED') === null ? [] : ['RCT-Folly/Fabric'])]) depend(name)
  if (family >= 88) appendPaths(config, prebuilt.deps ? ['$(PODS_ROOT)/ReactNativeDependencies/Headers'] : THIRD_PARTY_PATHS, refuse)
  else if (prebuilt.deps) {
    if (current === null || current === false) config.set('HEADER_SEARCH_PATHS', ['$(PODS_ROOT)/ReactNativeDependencies'])
  } else {
    if (current !== null && current !== false && !isText(current) && !Array.isArray(current)) refuse('`install_modules_dependencies` of header search paths that are no text or list')
    const paths = isText(current) ? words(current) : current || []
    paths.push(...THIRD_PARTY_PATHS)
    config.set('HEADER_SEARCH_PATHS', paths)
  }
  store(spec, config, refuse)
}

// add_rncore_dependency: the prebuilt core; with where its headers are in 83, with the overlay they are found
// through in 85, and alone in 88.
function prebuiltCore(family, spec, depend, refuse) {
  depend('React-Core-prebuilt')
  if (family >= 88) return
  const config = configOf(spec, refuse)
  const current = config.get('HEADER_SEARCH_PATHS') ?? null
  if (family === 83 && (current === null || current === false)) config.set('HEADER_SEARCH_PATHS', ['$(PODS_ROOT)/React-Core-prebuilt/React.xcframework/Headers'])
  for (const [field, flag] of family === 83 ? [] : [['OTHER_CFLAGS', ` -ivfsoverlay ${OVERLAY}`], ['OTHER_CPLUSPLUSFLAGS', ` -ivfsoverlay ${OVERLAY}`], ['OTHER_SWIFT_FLAGS', ` -Xcc -ivfsoverlay -Xcc ${OVERLAY}`]]) {
    const value = config.get(field) ?? '$(inherited)'
    config.set(field, isText(value) ? value + flag : refuse(`\`install_modules_dependencies\` of ${field} that is no text`))
  }
  store(spec, config, refuse)
}

// NewArchitectureHelper.install_modules_dependencies of 83 and later, whose architecture is the new one alone.
const installLater = (family) => (spec, state) => {
  const { env, prebuilt, refuse } = state
  const depend = (...args) => addDependency(spec, args, undefined, refuse)
  const flags = ' -DRCT_NEW_ARCH_ENABLED=1 '
  const config = configOf(spec, refuse)
  const paths = ['"$(PODS_ROOT)/Headers/Private/Yoga"']
  if (env('USE_FRAMEWORKS') !== null) paths.push(...frameworkPaths(family, prebuilt.core))
  addFlags(spec, flags, refuse)
  addPaths(config, paths, refuse)
  config.set('CLANG_CXX_LANGUAGE_STANDARD', CXX)
  depend('React-Core')
  inherit(config, 'OTHER_CPLUSPLUSFLAGS', flags, refuse)
  inherit(config, 'OTHER_SWIFT_FLAGS', ' -DRCT_NEW_ARCH_ENABLED', refuse)
  const modules = MODULES.map((name) => (family >= 88 && name === 'ReactCommon/turbomodule/bridging' ? 'React-bridging' : name))
  for (const name of [...modules, 'React-jsi', 'React-renderercss', ...(family >= 88 ? ['React-cxxstableapi'] : []), env('USE_THIRD_PARTY_JSC') === '1' ? 'React-jsc' : 'hermes-engine']) depend(name)
  // Each of these stores a copy, and the config at hand is stored over it: as in the Ruby, where the
  // specification had none before, what they added to the paths is lost. 83 has the core before that.
  thirdParty(family, spec, depend, state)
  if (prebuilt.core && family === 83) prebuiltCore(family, spec, depend, refuse)
  store(spec, config, refuse)
  if (prebuilt.core && family !== 83) prebuiltCore(family, spec, depend, refuse)
}

// The environment after use_react_native!, where the Podfile and the shell set nothing of it. `frameworks` is
// what pods are built as, which USE_FRAMEWORKS is set by; `prebuilt` what the lockfile has prebuilt, which is
// what the variables that ask for it are taken to have been.
function environment(family, { frameworks, prebuilt }) {
  const env = { RCT_NEW_ARCH_ENABLED: '1', RCT_FABRIC_ENABLED: '1', RCT_AGGREGATE_PRIVACY_FILES: '1' }
  if (isText(frameworks)) env.USE_FRAMEWORKS = frameworks
  if (family === 78) return { ...env, USE_HERMES: '1' }
  // 83 has prebuilt what is asked for, and the later ones what is not refused.
  if (prebuilt.deps || family > 83) env.RCT_USE_RN_DEP = prebuilt.deps ? '1' : '0'
  if (prebuilt.core || family > 83) env.RCT_USE_PREBUILT_RNCORE = prebuilt.core ? '1' : '0'
  if (family > 83) Object.assign(env, { RCT_REMOVE_LEGACY_ARCH: '1', RCT_HERMES_V1_ENABLED: '1' })
  if (family >= 88) Object.assign(env, { RCT_REMOVE_LEGACY_MODULE_INTEROP: '0', RCT_REMOVE_LEGACY_COMPONENT_INTEROP: '0' })
  return { ...env, RCT_SKIP_CODEGEN: '0' }
}

const FAMILIES = [[78, /^0\.78\.[0-3]$/u], [83, /^0\.83\.(?:\d|10)$/u], [85, /^0\.(?:85\.[0-3]|86\.[023])$/u], [88, /^0\.88\.[01]$/u]]
export const KNOWN = '0.78.0 to 0.78.3, 0.83.0 to 0.83.10, 0.85.0 to 0.86.3, 0.88.0 and 0.88.1'

// React Native's helpers of `version`, or undefined where they are not known: `env(context)`, the variables
// it leaves set; `podfile`, those it has of the Podfile; `values`, its helpers that are values; and
// `install(spec, { env, prebuilt, refuse })`, its install_modules_dependencies, where `env(name)` gives a
// variable or null, `prebuilt` is whether its `core` and its `deps` are, and `refuse(what)` throws.
export function reactNative(version) {
  const family = FAMILIES.find(([, versions]) => versions.test(version))?.[0]
  return family === undefined ? undefined : { env: (context) => environment(family, context), podfile: PODFILE, values: VALUES, install: family === 78 ? install78 : installLater(family) }
}
