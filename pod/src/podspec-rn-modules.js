// install_modules_dependencies of scripts/react_native_pods.rb and the helpers it is made of: what React Native
// does to a module's specification, each a port of a family's Ruby (podspec-rn.js).

import { addDependency, setAttribute } from './podspec-json.js'

// Helpers::Constants.
export const FOLLY_VERSION = '2024.11.18.00'
export const FOLLY_FLAGS = '-DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32'
export const FOLLY_FLAGS_78 = `-DFOLLY_NO_CONFIG ${FOLLY_FLAGS}`
export const CXX = 'c++20'

// The pods whose framework headers a module is given under frameworks: the family since which, the pod, and
// the directories of its headers given besides.
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

export const isText = (value) => typeof value === 'string'
// Ruby's split(" "): at runs of whitespace.
export const words = (value) => value.split(/[ \t\n\v\f\r]+/u).filter((word) => word !== '')

// ReactNativePodsUtils.create_header_search_path_for_frameworks: the headers of `pod`'s framework `name` under
// `base`, and `extra` in them; with a prebuilt core, which is no framework, the pod's own directory, but for
// ReactCodegen.
export function frameworkPath(pod, name, extra, prebuilt, base = 'PODS_CONFIGURATION_BUILD_DIR', own = true) {
  const headers = prebuilt && pod !== 'ReactCodegen' ? `\${PODS_ROOT}/${pod}` : `\${${base}}/${pod}/${name}.framework/Headers`
  return [...(own ? [headers] : []), ...extra.map((one) => `${headers}/${one}`)]
}
const frameworkPaths = (family, prebuilt) => FRAMEWORKS.filter(([since]) => since <= family).flatMap(([, pod, ...extra]) => frameworkPath(pod, pod === 'React-RCTFabric' ? 'RCTFabric' : pod.replace('-', '_'), extra, prebuilt).map((path) => `"${path}"`))

// A specification's own pod_target_xcconfig, so that a change to it changes the specification; a new one where
// it has none.
export function configOf(spec, refuse) {
  const config = spec.attributes.get('pod_target_xcconfig') ?? new Map()
  return config instanceof Map ? config : refuse('a pod_target_xcconfig that is no hash, given to a helper')
}
// `spec.pod_target_xcconfig = config`, which keeps a copy.
export const store = (spec, config, refuse) => setAttribute(spec, 'pod_target_xcconfig', new Map(config), undefined, refuse)

function addFlags(spec, computed, refuse) {
  const flags = spec.attributes.get('compiler_flags') ?? ''
  if (!isText(flags)) refuse('`install_modules_dependencies` of compiler flags that are no text')
  setAttribute(spec, 'compiler_flags', flags === '' ? computed.trim() : `${flags} ${computed}`, undefined, refuse)
}

function addPaths(config, paths, refuse) {
  const current = config.get('HEADER_SEARCH_PATHS') ?? ''
  if (!isText(current) && (!Array.isArray(current) || current.length > 0)) refuse('`install_modules_dependencies` of header search paths that are no text')
  config.set('HEADER_SEARCH_PATHS', current.length === 0 ? paths.join(' ') : `${current} ${paths.join(' ')}`)
}

// ReactNativePodsUtils.add_flag_to_map_with_inheritance.
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
export function install78(spec, { env, refuse }) {
  const depend = (...args) => addDependency(spec, args, undefined, refuse)
  const newArch = [null, '1'].includes(env('RCT_NEW_ARCH_ENABLED'))
  const flags = ` ${newArch ? '-DRCT_NEW_ARCH_ENABLED=1 ' : ''}${FOLLY_FLAGS_78}`
  const config = configOf(spec, refuse)
  const paths = ['"$(PODS_ROOT)/boost" "$(PODS_ROOT)/Headers/Private/Yoga"']
  if (env('USE_FRAMEWORKS') !== null) paths.push('"$(PODS_ROOT)/DoubleConversion"', '"$(PODS_ROOT)/fast_float/include"', '"$(PODS_ROOT)/fmt/include"', ...frameworkPaths(78, false))
  addFlags(spec, flags, refuse)
  addPaths(config, paths, refuse)
  config.set('CLANG_CXX_LANGUAGE_STANDARD', CXX)
  depend('React-Core')
  depend('RCT-Folly', FOLLY_VERSION)
  depend('glog')
  inherit(config, 'OTHER_CPLUSPLUSFLAGS', flags, refuse)
  inherit(config, 'OTHER_SWIFT_FLAGS', newArch ? ' -DRCT_NEW_ARCH_ENABLED' : '', refuse)
  for (const name of [...MODULES, 'DoubleConversion', [null, '1'].includes(env('USE_HERMES')) ? 'hermes-engine' : 'React-jsi']) depend(name)
  store(spec, config, refuse)
}

// ReactNativeDependenciesUtils.append_header_search_paths, 88's: `paths` quoted, but those there already.
function appendPaths(config, paths, refuse) {
  const current = config.get('HEADER_SEARCH_PATHS') ?? null
  const added = paths.map((path) => `"${path}"`).filter((path) => current === null || !current.includes(path))
  if (current !== null && !isText(current) && !Array.isArray(current)) refuse('`install_modules_dependencies` of header search paths that are no text or list')
  config.set('HEADER_SEARCH_PATHS', isText(current) ? [current, ...added].join(' ') : [...(current ?? []), ...added])
}

// add_rn_third_party_dependencies: the pods React Native is built on, or the one they are prebuilt as, and
// their headers.
export function thirdParty(family, spec, depend, { env, prebuilt, refuse }) {
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

// add_rncore_dependency: the prebuilt core; with its headers in 83, with the overlay they are found through in
// 85, and alone in 88.
export function prebuiltCore(family, spec, depend, refuse) {
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

// NewArchitectureHelper.install_modules_dependencies of 83 on, of the new architecture alone.
export const installLater = (family) => (spec, state) => {
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
  // Each of these stores a copy, which the config at hand is stored over: as in the Ruby, what they added is lost
  // where the specification had no config. 83 adds the core before that.
  thirdParty(family, spec, depend, state)
  if (prebuilt.core && family === 83) prebuiltCore(family, spec, depend, refuse)
  store(spec, config, refuse)
  if (prebuilt.core && family !== 83) prebuiltCore(family, spec, depend, refuse)
}
