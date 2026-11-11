// An Xcode project as Xcodeproj builds one: objects by their `isa` and attributes, holding one another. A key
// that starts with `_` is not written.

import { basename, extname, isAbsolute, posix, relative, sep } from 'node:path'

import { compareVersions } from './targets.js'

const FILE_TYPES = {
  a: 'archive.ar', apns: 'text', app: 'wrapper.application', appex: 'wrapper.app-extension', bundle: 'wrapper.plug-in', cpp: 'sourcecode.cpp.cpp',
  dylib: 'compiled.mach-o.dylib', entitlements: 'text.plist.entitlements', framework: 'wrapper.framework', gif: 'image.gif', gpx: 'text.xml',
  h: 'sourcecode.c.h', hpp: 'sourcecode.cpp.h', m: 'sourcecode.c.objc', markdown: 'text', mdimporter: 'wrapper.cfbundle', modulemap: 'sourcecode.module',
  mov: 'video.quicktime', mp3: 'audio.mp3', octest: 'wrapper.cfbundle', pch: 'sourcecode.c.h', plist: 'text.plist.xml', png: 'image.png',
  sh: 'text.script.sh', sks: 'file.sks', storyboard: 'file.storyboard', strings: 'text.plist.strings', swift: 'sourcecode.swift',
  xcassets: 'folder.assetcatalog', xcconfig: 'text.xcconfig', xcdatamodel: 'wrapper.xcdatamodel', xcodeproj: 'wrapper.pb-project', xctest: 'wrapper.cfbundle',
  xib: 'file.xib', zip: 'archive.zip',
}
const COMPATIBILITY = { 100: 'Xcode 26.3', 77: 'Xcode 16.0', 71: 'Xcode 16.2', 70: 'Xcode 16.0', 63: 'Xcode 15.3', 60: 'Xcode 15.0', 56: 'Xcode 14.0', 55: 'Xcode 13.0', 54: 'Xcode 12.0', 53: 'Xcode 11.4', 52: 'Xcode 11.0', 51: 'Xcode 10.0', 50: 'Xcode 9.3', 48: 'Xcode 8.0', 47: 'Xcode 6.3', 46: 'Xcode 3.2', 45: 'Xcode 3.1' }
// The SDK system frameworks are referenced in: Xcodeproj 1.28's last known.
const IOS_SDK = '26.0'

// Xcodeproj's PROJECT_DEFAULT_BUILD_SETTINGS, with Pod::Project's over them.
const ALL = {
  ALWAYS_SEARCH_USER_PATHS: 'NO', CLANG_ANALYZER_NONNULL: 'YES', CLANG_ANALYZER_NUMBER_OBJECT_CONVERSION: 'YES_AGGRESSIVE', CLANG_CXX_LANGUAGE_STANDARD: 'gnu++14',
  CLANG_CXX_LIBRARY: 'libc++', CLANG_ENABLE_MODULES: 'YES', CLANG_ENABLE_OBJC_ARC: 'YES', CLANG_ENABLE_OBJC_WEAK: 'YES', CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING: 'YES',
  CLANG_WARN_BOOL_CONVERSION: 'YES', CLANG_WARN_COMMA: 'YES', CLANG_WARN_CONSTANT_CONVERSION: 'YES', CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS: 'YES',
  CLANG_WARN_DIRECT_OBJC_ISA_USAGE: 'YES_ERROR', CLANG_WARN_DOCUMENTATION_COMMENTS: 'YES', CLANG_WARN_EMPTY_BODY: 'YES', CLANG_WARN_ENUM_CONVERSION: 'YES',
  CLANG_WARN_INFINITE_RECURSION: 'YES', CLANG_WARN_INT_CONVERSION: 'YES', CLANG_WARN_NON_LITERAL_NULL_CONVERSION: 'YES', CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF: 'YES',
  CLANG_WARN_OBJC_LITERAL_CONVERSION: 'YES', CLANG_WARN_OBJC_ROOT_CLASS: 'YES_ERROR', CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: 'YES',
  CLANG_WARN_RANGE_LOOP_ANALYSIS: 'YES', CLANG_WARN_STRICT_PROTOTYPES: 'YES', CLANG_WARN_SUSPICIOUS_MOVE: 'YES', CLANG_WARN_UNGUARDED_AVAILABILITY: 'YES_AGGRESSIVE',
  CLANG_WARN_UNREACHABLE_CODE: 'YES', CLANG_WARN__DUPLICATE_METHOD_MATCH: 'YES', COPY_PHASE_STRIP: 'NO', ENABLE_STRICT_OBJC_MSGSEND: 'YES',
  GCC_C_LANGUAGE_STANDARD: 'gnu11', GCC_NO_COMMON_BLOCKS: 'YES', GCC_WARN_64_TO_32_BIT_CONVERSION: 'YES', GCC_WARN_ABOUT_RETURN_TYPE: 'YES_ERROR',
  GCC_WARN_UNDECLARED_SELECTOR: 'YES', GCC_WARN_UNINITIALIZED_AUTOS: 'YES_AGGRESSIVE', GCC_WARN_UNUSED_FUNCTION: 'YES', GCC_WARN_UNUSED_VARIABLE: 'YES',
  MTL_FAST_MATH: 'YES', PRODUCT_NAME: '$(TARGET_NAME)', SWIFT_VERSION: '5.0', STRIP_INSTALLED_PRODUCT: 'NO', CLANG_ANALYZER_LOCALIZABILITY_NONLOCALIZED: 'YES', SYMROOT: '${SRCROOT}/../build',
}
const BY_TYPE = {
  debug: { DEBUG_INFORMATION_FORMAT: 'dwarf', ENABLE_TESTABILITY: 'YES', GCC_DYNAMIC_NO_PIC: 'NO', GCC_OPTIMIZATION_LEVEL: '0', MTL_ENABLE_DEBUG_INFO: 'INCLUDE_SOURCE', ONLY_ACTIVE_ARCH: 'YES', SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG', SWIFT_OPTIMIZATION_LEVEL: '-Onone' },
  release: { DEBUG_INFORMATION_FORMAT: 'dwarf-with-dsym', ENABLE_NS_ASSERTIONS: 'NO', MTL_ENABLE_DEBUG_INFO: 'NO', SWIFT_COMPILATION_MODE: 'wholemodule', SWIFT_OPTIMIZATION_LEVEL: '-O' },
}

// Pod::Project#add_build_configuration: POD_CONFIGURATION_<NAME>, by ActiveSupport's underscore of the name.
function definitionsOf(name, type) {
  const underscored = name.replaceAll(/([A-Z\d]+)([A-Z][a-z])/gu, '$1_$2').replaceAll(/([a-z\d])([A-Z])/gu, '$1_$2').replaceAll('-', '_').toLowerCase()
  const definition = `POD_CONFIGURATION_${underscored}`.replaceAll(/[^a-zA-Z0-9_]/gu, '_').toUpperCase()
  return [`${definition}=1`, ...(type === 'debug' ? ['DEBUG=1'] : []), '$(inherited)']
}

// A configuration for each of the project's, with `settingsOf(type, name)`.
const configurationList = (project, settingsOf) => ({
  isa: 'XCConfigurationList',
  buildConfigurations: Object.entries(project.configurations).map(([name, type]) => ({ isa: 'XCBuildConfiguration', name, buildSettings: settingsOf(type, name) })),
  defaultConfigurationIsVisible: '0',
  defaultConfigurationName: 'Release',
})
export const configurationsOf = (target) => target.buildConfigurationList.buildConfigurations
export function setAll(target, key, value) {
  for (const configuration of configurationsOf(target)) configuration.buildSettings[key] = value
}

// `configurations` are the app's, each `debug` or `release` by name; `dir` is the directory of the .xcodeproj.
export function newProject(dir, configurations, objectVersion, deploymentTarget) {
  const mainGroup = { isa: 'PBXGroup', children: [], sourceTree: '<group>', _real: dir }
  const project = { dir, objectVersion: String(objectVersion), configurations, mainGroup, refs: new Map(), targets: [] }
  project.root = {
    isa: 'PBXProject',
    attributes: { LastSwiftUpdateCheck: '1600', LastUpgradeCheck: '1600' },
    buildConfigurationList: configurationList(project, (type, name) => ({ ...ALL, ...BY_TYPE[type], GCC_PREPROCESSOR_DEFINITIONS: definitionsOf(name, type), IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget })),
    compatibilityVersion: COMPATIBILITY[objectVersion] ?? 'Xcode 3.2',
    developmentRegion: 'en',
    hasScannedForEncodings: '0',
    knownRegions: ['Base', 'en'],
    mainGroup,
    minimizedProjectReferenceProxies: '0',
    preferredProjectObjectVersion: '100',
    projectDirPath: '',
    projectRoot: '',
    targets: project.targets,
  }
  return project
}

// A group of `parent`; with `dir`, one whose files are in that directory. `isa` makes a variant group.
export function newGroup(parent, name, dir, isa = 'PBXGroup') {
  const group = { isa, children: [], name, sourceTree: '<group>', _real: dir ?? parent._real }
  if (dir !== undefined) group.path = pathFrom(parent._real, dir)
  parent.children.push(group)
  return group
}
export const groupNamed = (parent, name) => parent.children.find((child) => child.isa === 'PBXGroup' && (child.name ?? child.path) === name)
export const pathFrom = (from, to) => relative(from, to).split(sep).join('/') || '.'

// A file's reference in `group`, by its path from the group's directory, typed by its extension.
export function newFile(project, group, path) {
  if (project.refs.has(path)) return project.refs.get(path)
  const from = isAbsolute(path) ? pathFrom(group._real, path) : path
  // FileReferencesFactory#configure_defaults_for_file_reference: a framework is not indexed.
  const ref = { isa: 'PBXFileReference', ...(extname(path).toLowerCase() === '.framework' ? {} : { includeInIndex: '1' }), path: from, sourceTree: '<group>', _real: path }
  const type = FILE_TYPES[extname(path).slice(1)]
  if (type !== undefined) ref.lastKnownFileType = type
  if (from.includes('/')) ref.name = basename(path)
  group.children.push(ref)
  project.refs.set(path, ref)
  return ref
}

const displayName = (object) => object.name ?? (object.path === undefined ? object.isa : posix.basename(object.path))
const stemOf = (name) => posix.basename(name.toLowerCase(), posix.extname(name.toLowerCase()))
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// Xcodeproj's order of a group's children and a phase's files: by name without extension, then extension, then
// path, all in lower case.
function byName(a, b, pathOf) {
  const x = displayName(a)
  const y = displayName(b)
  return compare(stemOf(x), stemOf(y)) || compare(posix.extname(x.toLowerCase()), posix.extname(y.toLowerCase())) || compare((pathOf(a) ?? '').toLowerCase(), (pathOf(b) ?? '').toLowerCase())
}

// Project#sort(:groups_position => :below), as CocoaPods sorts the project before writing it.
export function sortProject(project) {
  const sortGroup = (group) => {
    const isGroup = (child) => child.isa === 'PBXGroup'
    group.children.sort((a, b) => (isGroup(a) === isGroup(b) ? byName(a, b, (one) => one.path) : isGroup(a) ? 1 : -1))
    for (const child of group.children) if (isGroup(child)) sortGroup(child)
  }
  sortGroup(project.mainGroup)
  const lower = (a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase())
  configurationsOf(project.root).sort(lower)
  project.targets.sort(lower)
  for (const target of project.targets) {
    configurationsOf(target).sort(lower)
    target.dependencies.sort((a, b) => compare(a.name, b.name))
    for (const phase of target.buildPhases) phase.files?.sort((a, b) => byName(a.fileRef, b.fileRef, (one) => one._real))
  }
}

const PRODUCT_TYPES = { framework: 'com.apple.product-type.framework', static_library: 'com.apple.product-type.library.static', bundle: 'com.apple.product-type.bundle' }
const PHASES = { framework: ['Headers', 'Sources', 'Frameworks', 'Resources'], static_library: ['Headers', 'Sources', 'Frameworks'], bundle: ['Sources', 'Frameworks', 'Resources'] }
const COMMON = {
  framework: { CURRENT_PROJECT_VERSION: '1', DEFINES_MODULE: 'YES', DYLIB_COMPATIBILITY_VERSION: '1', DYLIB_CURRENT_VERSION: '1', DYLIB_INSTALL_NAME_BASE: '@rpath', INSTALL_PATH: '$(LOCAL_LIBRARY_DIR)/Frameworks', PRODUCT_NAME: '$(TARGET_NAME:c99extidentifier)', SKIP_INSTALL: 'YES', VERSION_INFO_PREFIX: '', VERSIONING_SYSTEM: 'apple-generic', LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks @loader_path/Frameworks', TARGETED_DEVICE_FAMILY: '1,2' },
  static_library: { OTHER_LDFLAGS: '-ObjC', SKIP_INSTALL: 'YES', TARGETED_DEVICE_FAMILY: '1,2' },
  bundle: { WRAPPER_EXTENSION: 'bundle', SKIP_INSTALL: 'YES' },
  // Xcodeproj takes an aggregate target for an application.
  application: { ASSETCATALOG_COMPILER_APPICON_NAME: 'AppIcon', ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: 'AccentColor', LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks', TARGETED_DEVICE_FAMILY: '1,2' },
}

// ProjectHelper.common_build_settings of iOS. Xcodeproj compares the deployment target as text.
function commonSettings(type, productType, deploymentTarget) {
  const settings = { SDKROOT: 'iphoneos', ...(type === 'release' ? { VALIDATE_PRODUCT: 'YES' } : {}), ...COMMON[productType] }
  if (deploymentTarget !== undefined) {
    settings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget
    if (deploymentTarget < '5') settings.CLANG_ENABLE_OBJC_WEAK = 'NO'
  }
  return settings
}

// CocoaPods builds for 64 bits alone from iOS 11 on, in a project of a format before Xcode 9.3's.
const only64Bit = (deploymentTarget, objectVersion) => compareVersions(deploymentTarget, '11.0') >= 0 && Number(objectVersion) < 50

// What CocoaPods sets on every target it adds, over Xcodeproj's settings.
export const targetDefaults = (deploymentTarget, objectVersion) => ({
  ...(only64Bit(deploymentTarget, objectVersion) ? { ARCHS: '$(ARCHS_STANDARD_64_BIT)' } : {}),
  ENABLE_USER_SCRIPT_SANDBOXING: 'NO',
  ENABLE_MODULE_VERIFIER: 'NO',
  'CODE_SIGN_IDENTITY[sdk=appletvos*]': '',
  'CODE_SIGN_IDENTITY[sdk=iphoneos*]': '',
  'CODE_SIGN_IDENTITY[sdk=watchos*]': '',
})

export const newPhase = (kind, attributes = {}) => ({ isa: `PBX${kind}BuildPhase`, buildActionMask: '2147483647', files: [], runOnlyForDeploymentPostprocessing: '0', ...attributes })

function productsGroup(project) {
  project.products ??= newGroup(project.mainGroup, 'Products')
  project.root.productRefGroup = project.products
  return project.products
}

// A native target with its product, its configurations of `settings`, and its phases.
export function newTarget(project, name, productType, productFile, settings, deploymentTarget) {
  const product = { isa: 'PBXFileReference', explicitFileType: productType === 'bundle' ? 'wrapper.cfbundle' : FILE_TYPES[extname(productFile).slice(1)], includeInIndex: '0', name, path: productFile, sourceTree: 'BUILT_PRODUCTS_DIR' }
  productsGroup(project).children.push(product)
  const target = {
    isa: 'PBXNativeTarget',
    buildConfigurationList: configurationList(project, (type) => ({ ...commonSettings(productType === 'bundle' ? undefined : type, productType, deploymentTarget), ...settings })),
    buildPhases: PHASES[productType].map((kind) => newPhase(kind)),
    buildRules: [],
    dependencies: [],
    name,
    productName: posix.basename(productFile, posix.extname(productFile)).replace(productType === 'static_library' ? /^lib/u : /^$/u, ''),
    productReference: product,
    productType: PRODUCT_TYPES[productType],
  }
  project.targets.push(target)
  return target
}

// A target that builds nothing, which stands for a pod of headers alone.
export function newAggregateTarget(project, name, settings, deploymentTarget) {
  const target = {
    isa: 'PBXAggregateTarget',
    buildConfigurationList: configurationList(project, (type) => ({ ...commonSettings(type, 'application', deploymentTarget), ...settings })),
    buildPhases: [],
    dependencies: [],
    name,
  }
  project.targets.push(target)
  return target
}

export const phaseOf = (target, kind) => target.buildPhases.find((phase) => phase.isa === `PBX${kind}BuildPhase`)
// NativeTarget#add_file_references and #add_resources: a reference is in a phase once. Added again, as by two
// subspecs, its build file's compiler flags are added to.
export function addFile(target, kind, ref, settings) {
  const phase = phaseOf(target, kind)
  let file = phase.files.find((one) => one.fileRef === ref)
  if (file === undefined) phase.files.push(file = { isa: 'PBXBuildFile', fileRef: ref })
  if (settings === undefined) return file
  const flags = [file.settings?.COMPILER_FLAGS, settings.COMPILER_FLAGS].filter((one) => one !== undefined).join(' ')
  file.settings = { ...file.settings, ...settings, ...(flags === '' ? {} : { COMPILER_FLAGS: flags }) }
  return file
}

// NativeTarget#add_system_framework, of iOS.
export function addSystemFramework(project, target, name) {
  project.frameworks ??= newGroup(project.mainGroup, 'Frameworks')
  const group = groupNamed(project.frameworks, 'iOS') ?? newGroup(project.frameworks, 'iOS')
  const path = `Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS${IOS_SDK}.sdk/System/Library/Frameworks/${name}.framework`
  let ref = group.children.find((child) => child.path === path)
  if (ref === undefined) group.children.push(ref = { isa: 'PBXFileReference', lastKnownFileType: 'wrapper.framework', name: `${name}.framework`, path, sourceTree: 'DEVELOPER_DIR' })
  if (!phaseOf(target, 'Frameworks').files.some((file) => file.fileRef === ref)) addFile(target, 'Frameworks', ref)
}

export function addDependency(project, target, on) {
  if (target.dependencies.some((dependency) => dependency.target === on)) return
  target.dependencies.push({ isa: 'PBXTargetDependency', name: on.name, target: on, targetProxy: { isa: 'PBXContainerItemProxy', containerPortal: project.root, proxyType: '1', remoteGlobalIDString: on, remoteInfo: on.name } })
}

// The settings that are lists in a project file, before Xcode 9.3's format and from it on.
const LISTS = ['ALTERNATE_PERMISSIONS_FILES', 'ARCHS', 'BUILD_VARIANTS', 'EXCLUDED_SOURCE_FILE_NAMES', 'FRAMEWORK_SEARCH_PATHS', 'GCC_PREPROCESSOR_DEFINITIONS', 'GCC_PREPROCESSOR_DEFINITIONS_NOT_USED_IN_PRECOMPS', 'HEADER_SEARCH_PATHS', 'INFOPLIST_PREPROCESSOR_DEFINITIONS', 'LIBRARY_SEARCH_PATHS', 'OTHER_CFLAGS', 'OTHER_CPLUSPLUSFLAGS', 'OTHER_LDFLAGS', 'REZ_SEARCH_PATHS', 'SECTORDER_FLAGS', 'WARNING_CFLAGS', 'WARNING_LDFLAGS']
const LISTS_50 = [...LISTS, 'INCLUDED_SOURCE_FILE_NAMES', 'LD_RUNPATH_SEARCH_PATHS', 'LOCALIZED_STRING_MACRO_NAMES', 'SYSTEM_FRAMEWORK_SEARCH_PATHS', 'SYSTEM_HEADER_SEARCH_PATHS', 'USER_HEADER_SEARCH_PATHS']

// XCBuildConfiguration#normalize_array_settings: one of LISTS of more than one word is a list, any other a string.
export function normalizeSettings(project) {
  const lists = new Set(Number(project.objectVersion) >= 50 ? LISTS_50 : LISTS)
  for (const { buildSettings } of [project.root, ...project.targets].flatMap(configurationsOf)) {
    for (const [key, value] of Object.entries(buildSettings)) {
      const listed = lists.has(key.replace(/\[[^\]]+\]$/u, ''))
      if (Array.isArray(value)) {
        if (!(value.length > 1 && listed)) buildSettings[key] = value.join(' ')
      } else if (listed) {
        const words = [...value.matchAll(/ *((['"]?).*?[^\\]\2)(?=( |$))/gu)].map((match) => match[1])
        if (words.length > 1) buildSettings[key] = words
      }
    }
  }
}
