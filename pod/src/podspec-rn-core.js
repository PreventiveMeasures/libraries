// The helpers React Native's podspecs are written with, scripts/react_native_pods.rb's and those it loads: what
// each gives, and what each does to a specification. Each is a port of one family's own Ruby; podspec-rn.js
// has the families. A helper is called with `{ args, options, env, prebuilt, refuse }`: what it is given in
// its place and by name, `env(name)` a variable of the environment or null, `prebuilt` whether React Native's
// `core` and its `deps` are, and `refuse(what)`, which throws.

import { addDependency, setAttribute } from './podspec-json.js'
import { CXX, FOLLY_FLAGS, FOLLY_FLAGS_78, FOLLY_VERSION, configOf, frameworkPath, install78, installLater, isText, prebuiltCore, store, thirdParty, words } from './podspec-rn-modules.js'

const IOS = '15.1'
const FOLLY_CONFIG_FILE = ['#pragma once', '', '#define FOLLY_MOBILE 1', '#define FOLLY_USE_LIBCPP 1', '#define FOLLY_HAVE_PTHREAD 1', '#define FOLLY_CFG_NO_COROUTINES 1', '#define FOLLY_HAVE_CLOCK_GETTIME 1', '', '#pragma clang diagnostic ignored "-Wcomma"']
const GIT = { glog: 'https://github.com/google/glog.git', fast_float: 'https://github.com/fastfloat/fast_float.git', fmt: 'https://github.com/fmtlib/fmt.git', double_conversion: 'https://github.com/google/double-conversion.git' }

const isSpec = (value) => value !== null && typeof value === 'object' && value.attributes instanceof Map
const truthy = (value) => value !== null && value !== undefined && value !== false

// What a helper is given, held to what it takes: `count` values in their places, the first a specification
// where `ofSpec`, and by name none but `names`, as Ruby holds a call to a method's parameters.
function given({ args, options, refuse }, count, names = [], ofSpec = false) {
  if (args.length !== count || [...options.keys()].some((name) => !names.includes(name)) || (ofSpec && !isSpec(args[0]))) refuse('a helper given what it does not take')
  return [...args, ...names.map((name) => options.get(name))]
}
const constant = (value) => (call) => given(call, 0) && value()
const ofSpec = (change) => (call) => {
  const [spec] = given(call, 1, [], true)
  change(spec, (...args) => addDependency(spec, args, undefined, call.refuse), call)
  return null
}

// Helpers::Constants: the config of each of the pods React Native is built on, a hash of its own each time.
function configs(family) {
  const folly = [['version', FOLLY_VERSION], ['git', 'https://github.com/facebook/folly.git'], ['compiler_flags', family === 78 ? FOLLY_FLAGS_78 : FOLLY_FLAGS], ...(family === 78 ? [] : [['config_file', FOLLY_CONFIG_FILE]]), ['dep_name', 'RCT-Folly/Fabric']]
  return {
    get_folly_config: constant(() => new Map(folly.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]))),
    get_boost_config: constant(() => new Map([['git', 'https://github.com/react-native-community/boost-for-react-native'], ['compiler_flags', '-Wno-documentation']])),
    get_socket_rocket_config: constant(() => new Map([['version', '0.7.1']])),
    ...Object.fromEntries(Object.entries(GIT).map(([name, git]) => [`get_${name}_config`, constant(() => new Map([['git', git]]))])),
  }
}

// add_dependency: a dependency on `pod`, with where the headers of its framework are among the header search
// paths, whether or not pods are frameworks. The subspec it is given by name it does not pass on, in any family.
const addPod = (family) => (call) => {
  const [spec, pod, , extra = [], name = null, version = null, base = 'PODS_CONFIGURATION_BUILD_DIR'] = given(call, 2, ['subspec', 'additional_framework_paths', 'framework_name', 'version', 'base_dir'], true)
  const { prebuilt, refuse } = call
  // 78 reads the config of a specification that has none, which fails.
  if (family === 78 && !(spec.attributes.get('pod_target_xcconfig') instanceof Map)) refuse('`add_dependency` of a specification without a pod_target_xcconfig')
  const config = configOf(spec, refuse)
  const current = config.get('HEADER_SEARCH_PATHS') ?? ''
  const texts = (value) => Array.isArray(value) && value.every(isText)
  if (!isText(pod) || !(isText(current) || texts(current)) || !texts(extra) || !isText(base)) refuse('`add_dependency` of what is no text')
  const paths = frameworkPath(pod, name ?? pod.replaceAll('-', '_'), extra, family > 78 && prebuilt.core, base)
  // The paths at hand are split at their spaces: those of a list, as ActiveSupport has `split` of a list do,
  // into the lists between those of them that are a space, each of which is then joined in its place.
  const had = isText(current) ? words(current) : current.reduce((parts, path) => (path === ' ' ? [...parts, []] : [...parts.slice(0, -1), [...parts.at(-1), path]]), [[]]).map((part) => part.join(' '))
  config.set('HEADER_SEARCH_PATHS', [...had, ...paths.map((path) => `"${path}"`)].join(' '))
  store(spec, config, refuse)
  addDependency(spec, truthy(version) ? [pod, version] : [pod], undefined, refuse)
  return null
}

// create_header_search_path_for_frameworks: the paths add_dependency adds, for a podspec to add them itself.
const searchPaths = (family) => (call) => {
  const [pod, extra = [], name = null, base = 'PODS_CONFIGURATION_BUILD_DIR', own = true] = given(call, 1, ['additional_framework_paths', 'framework_name', 'base_dir', 'include_base_folder'])
  if (!isText(pod) || !Array.isArray(extra) || !extra.every(isText) || !isText(base)) call.refuse('`create_header_search_path_for_frameworks` of what is no text')
  return frameworkPath(pod, name ?? pod.replaceAll('-', '_'), extra, family > 78 && call.prebuilt.core, base, truthy(own))
}

// resolve_use_frameworks: the module's name, and where its headers are mapped from, where pods are frameworks;
// the latter only where the core is built, a prebuilt one being no framework.
function resolveFrameworks(call) {
  const [spec, mappings = null, name = null] = given(call, 1, ['header_mappings_dir', 'module_name'], true)
  if (call.env('USE_FRAMEWORKS') === null) return null
  if (truthy(name)) setAttribute(spec, 'module_name', name, undefined, call.refuse)
  if (mappings !== null && !call.prebuilt.core) setAttribute(spec, 'header_mappings_dir', mappings, undefined, call.refuse)
  return null
}

// mark_as_react_native_build, 88's: the definition that says a pod is built as part of React Native.
function markBuild(spec, depend, { refuse }) {
  const config = configOf(spec, refuse)
  const had = config.get('GCC_PREPROCESSOR_DEFINITIONS') || '$(inherited)'
  const definitions = Array.isArray(had) && had.every(isText) ? had.join(' ') : had
  if (!isText(definitions)) refuse('`mark_as_react_native_build` of definitions that are no text')
  const stripped = definitions.trim() === '' ? '$(inherited)' : definitions.trim()
  if (stripped.includes('RN_BUILDING=1')) return
  config.set('GCC_PREPROCESSOR_DEFINITIONS', `${stripped} RN_BUILDING=1`)
  store(spec, config, refuse)
}

// The helpers of `family`, by name.
export function helpersOf(family) {
  const jsc = (call) => call.env('USE_THIRD_PARTY_JSC') === '1'
  const all = {
    install_modules_dependencies: ofSpec((spec, depend, call) => (family === 78 ? install78 : installLater(family))(spec, call)),
    min_ios_version_supported: constant(() => IOS),
    min_supported_versions: constant(() => new Map([['ios', IOS]])),
    rct_cxx_language_standard: constant(() => CXX),
    folly_flags: constant(() => (family === 78 ? FOLLY_FLAGS_78 : FOLLY_FLAGS)),
    add_dependency: addPod(family),
    create_header_search_path_for_frameworks: searchPaths(family),
    ...configs(family),
  }
  if (family === 78) return all
  return {
    ...all,
    use_third_party_jsc: (call) => given(call, 0) && jsc(call),
    use_hermes: (call) => given(call, 0) && !jsc(call),
    use_hermes_flags: constant(() => '-DUSE_HERMES=1'),
    use_third_party_jsc_flags: constant(() => '-DUSE_THIRD_PARTY_JSC=1'),
    js_engine_flags: (call) => given(call, 0) && (jsc(call) ? '-DUSE_THIRD_PARTY_JSC=1' : '-DUSE_HERMES=1'),
    podspec_sources: (call) => given(call, 2)[call.prebuilt.core ? 1 : 0],
    resolve_use_frameworks: resolveFrameworks,
    depend_on_js_engine: ofSpec((spec, depend, call) => depend(jsc(call) ? 'React-jsc' : 'hermes-engine')),
    add_rn_third_party_dependencies: ofSpec((spec, depend, call) => thirdParty(family, spec, depend, call)),
    add_rncore_dependency: ofSpec((spec, depend, call) => call.prebuilt.core && prebuiltCore(family, spec, depend, call.refuse)),
    'ReactNativeCoreUtils.build_rncore_from_source': (call) => given(call, 0) && !call.prebuilt.core,
    'ReactNativeDependenciesUtils.build_react_native_deps_from_source': (call) => given(call, 0) && !call.prebuilt.deps,
    ...(family >= 88 && { mark_as_react_native_build: ofSpec(markBuild) }),
  }
}
