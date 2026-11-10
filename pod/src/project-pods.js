// A pod in the Pods project, as CocoaPods' FileReferencesInstaller and PodTargetInstaller put one there: its
// group of files, its target with their build phases, the targets of its resource bundles, and its script
// phases. What is written beside it, in Target Support Files, is gathered in `files`, by its path from Pods/.

import { extname, join, posix } from 'node:path'

import { PodError, quote } from './error.js'
import { HEADERS } from './files.js'
import { addFile, addSystemFramework, groupNamed, newAggregateTarget, newFile, newGroup, newPhase, newTarget, only64Bit, phaseOf } from './project.js'
import { addKnownRegions, addLocalized, allowablePaths, isLproj, mergeDocc, resourceRefs } from './project-resources.js'
import { XCFRAMEWORKS_DIR } from './settings.js'
import { compareVersions } from './targets.js'

const SOURCES = new Set(['.m', '.mm', '.i', '.c', '.cc', '.cxx', '.cpp', '.c++', '.swift', ...HEADERS])
const SUBGROUPS = { resources: 'Resources', frameworks: 'Frameworks', developer: 'Pod' }
const COMPILED_RESOURCES = new Set(['.storyboard', '.xib', '.xcdatamodel', '.xcdatamodeld', '.xcmappingmodel'])
const SYMLINK_HEADERS = 'cd "$CONFIGURATION_BUILD_DIR/$WRAPPER_NAME" || exit 1\nif [ ! -d Versions ]; then\n  # Not a versioned framework, so no need to do anything\n  exit 0\nfi\n\npublic_path="${PUBLIC_HEADERS_FOLDER_PATH#$CONTENTS_FOLDER_PATH/}"\nif [ ! -f "$public_path" ]; then\n  ln -fs "${PUBLIC_HEADERS_FOLDER_PATH#$WRAPPER_NAME/}" "$public_path"\nfi\n\nprivate_path="${PRIVATE_HEADERS_FOLDER_PATH#$CONTENTS_FOLDER_PATH/}"\nif [ ! -f "$private_path" ]; then\n  ln -fs "${PRIVATE_HEADERS_FOLDER_PATH#$WRAPPER_NAME/}" "$private_path"\nfi\n'

// Project#group_for_spec: a pod's group, a subspec's under it by its names, and one of SUBGROUPS in that.
function groupForSpec(podGroup, pod, specName, key) {
  let group = podGroup
  for (const name of specName === pod ? [] : specName.slice(pod.length + 1).split('/')) group = groupNamed(group, name) ?? newGroup(group, name)
  return key === undefined ? group : groupNamed(group, SUBGROUPS[key]) ?? newGroup(group, SUBGROUPS[key])
}

// FileReferencesInstaller#common_path: the directory that the least and the greatest of the files' own share.
function commonDir(paths) {
  const dirs = paths.map((path) => posix.dirname(path)).sort()
  const least = dirs[0].split('/')
  const most = dirs.at(-1).split('/')
  let shared = 0
  while (shared < least.length && least[shared] === most[shared]) shared++
  const dir = least.slice(0, shared).join('/')
  return dir === '' || dir === '.' ? undefined : dir
}

// The references of an accessor's files: of a local pod's sources and resources, in groups as its directories
// are, from the directory they share and down to an .lproj; else under `key`'s group of the spec. A file that
// has one, as of another subspec, keeps it, and no group is made for it.
function addPaths(project, target, podGroup, accessor, given, key, reflect) {
  const paths = allowablePaths(target.list, given)
  if (paths.length === 0) return []
  const structured = target.local && reflect
  const base = structured ? commonDir(paths) : undefined
  const specGroup = groupForSpec(podGroup, target.name, accessor.spec.name, structured ? undefined : key)
  return paths.map((path) => {
    if (project.refs.has(join(target.dir, path))) return project.refs.get(join(target.dir, path))
    let group = specGroup
    const dirs = posix.dirname(base === undefined ? path : posix.relative(base, path)).split('/').filter((part) => part !== '.')
    let dir = base === undefined ? target.dir : join(target.dir, base)
    for (const name of structured ? dirs : []) {
      if (isLproj(name)) break
      dir = join(dir, name)
      group = groupNamed(group, name) ?? newGroup(group, name, dir)
    }
    return isLproj(dirs.at(-1) ?? '') ? addLocalized(project, group, target, path) : newFile(project, group, join(target.dir, path))
  })
}

export function addPodFiles(project, target, sandbox) {
  const parent = target.local ? project.developmentPods : project.pods
  const podGroup = target.group = newGroup(parent, target.name, target.dir)
  for (const accessor of target.accessors) {
    addPaths(project, target, podGroup, accessor, accessor.sourceFiles, undefined, true)
    addPaths(project, target, podGroup, accessor, accessor.vendoredFrameworks, 'frameworks', false)
    addPaths(project, target, podGroup, accessor, accessor.vendoredLibraries, 'frameworks', false)
    const resources = addPaths(project, target, podGroup, accessor, accessor.resources, 'resources', true)
    const bundled = addPaths(project, target, podGroup, accessor, Object.values(accessor.resourceBundles).flat(), 'resources', true)
    addKnownRegions(project, [...resources, ...bundled])
  }
  if (target.local) for (const path of target.developerFiles) newFile(project, groupForSpec(podGroup, target.name, target.name, 'developer'), join(target.dir, path))
  target.supportGroup = newGroup(podGroup, 'Support Files', join(sandbox, 'Target Support Files', target.label))
}

// PodTargetInstaller#compiler_flags_for_consumer.
function compilerFlags(target, consumer, arc, swift) {
  const flags = [...consumer.compiler_flags]
  if (!arc && !swift) flags.push('-fno-objc-arc')
  else if (target.specTargets.get(consumer.spec) === undefined || compareVersions(target.specTargets.get(consumer.spec), '6.0') < 0) flags.push('-DOS_OBJECT_USE_OBJC=0')
  if (target.inhibitWarnings && !swift) flags.push('-w -Xanalyzer -analyzer-disable-all-checks')
  return flags.join(' ')
}

// PodTargetInstaller#add_header: a header's visibility; where the pod is a framework with a header_mappings_dir,
// one that is not of the project is copied into its directory by a phase of its own, moved before the sources.
function addHeader(native, target, accessor, file, path) {
  const visibility = accessor.publicHeaders.includes(path) ? 'Public' : accessor.projectHeaders.includes(path) ? 'Project' : accessor.privateHeaders.includes(path) ? 'Private' : 'Project'
  const acl = target.framework ? visibility : 'Project'
  const mappingsDir = accessor.consumer.header_mappings_dir
  if (!target.framework || !mappingsDir || acl === 'Project') {
    file.settings = { ATTRIBUTES: [acl] }
    return
  }
  const subDir = posix.dirname(posix.relative(mappingsDir, path))
  const name = `Copy ${subDir} ${acl} Headers`
  const compile = native.buildPhases.indexOf(phaseOf(native, 'Sources'))
  let phase = native.buildPhases.find((one) => one.isa === 'PBXCopyFilesBuildPhase' && one.name === name)
  if (phase === undefined) native.buildPhases.push(phase = newPhase('CopyFiles', { name }))
  native.buildPhases.splice(native.buildPhases.indexOf(phase), 1)
  native.buildPhases.splice(compile - 1, 0, phase)
  phase.dstSubfolderSpec = '16'
  phase.dstPath = `$(${acl.toUpperCase()}_HEADERS_FOLDER_PATH)/${subDir}`
  if (!phase.files.some((one) => one.fileRef === file.fileRef)) phase.files.push({ isa: 'PBXBuildFile', fileRef: file.fileRef })
}

function addSources(project, native, target) {
  const refOf = (path) => project.refs.get(join(target.dir, path))
  for (const accessor of target.accessors) {
    const headers = new Set(accessor.headers)
    const arc = new Set(accessor.arcSourceFiles)
    const compiled = accessor.sourceFiles.filter((path) => !headers.has(path) && SOURCES.has(extname(path)))
    for (const isArc of [true, false]) {
      for (const swift of [false, true]) {
        const flags = compilerFlags(target, accessor.consumer, isArc, swift)
        for (const path of compiled.filter((one) => arc.has(one) === isArc && (extname(one) === '.swift') === swift)) addFile(native, 'Sources', refOf(path), flags === '' ? undefined : { COMPILER_FLAGS: flags })
      }
    }
    for (const path of accessor.headers) addHeader(native, target, accessor, addFile(native, 'Headers', refOf(path)), path)
    for (const path of mergeDocc(target.list, accessor.sourceFiles.filter((one) => !SOURCES.has(extname(one))))) addFile(native, 'Sources', refOf(path))
    if (!target.framework) continue
    // A static framework's resources are copied by the app, but for those that are compiled.
    const resources = resourceRefs(project, target, accessor.resources)
    for (const ref of resources.compiled) addFile(native, 'Sources', ref)
    for (const ref of resources.copied) if (!target.static || COMPILED_RESOURCES.has(extname(ref.name ?? ref.path))) addFile(native, 'Resources', ref)
  }
}

// The settings CocoaPods gives a pod's target over Xcodeproj's own, less those its specs set themselves.
function targetSettings(target, project, objectVersion) {
  const settings = {
    ...(only64Bit(target.platform.target, objectVersion) ? { ARCHS: '$(ARCHS_STANDARD_64_BIT)' } : {}),
    ...(target.framework ? { MACH_O_TYPE: 'staticlib' } : { OTHER_LDFLAGS: '', OTHER_LIBTOOLFLAGS: '', PRIVATE_HEADERS_FOLDER_PATH: '', PUBLIC_HEADERS_FOLDER_PATH: '' }),
    ENABLE_USER_SCRIPT_SANDBOXING: 'NO',
    ENABLE_MODULE_VERIFIER: 'NO',
    PRODUCT_NAME: target.productBasename,
    PRODUCT_MODULE_NAME: target.moduleName,
    'CODE_SIGN_IDENTITY[sdk=appletvos*]': '',
    'CODE_SIGN_IDENTITY[sdk=iphoneos*]': '',
    'CODE_SIGN_IDENTITY[sdk=watchos*]': '',
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: '$(inherited) ',
    GENERATE_INFOPLIST_FILE: 'NO',
    SWIFT_INSTALL_OBJC_HEADER: 'YES',
    ...(target.swiftVersion === undefined ? {} : { SWIFT_VERSION: target.swiftVersion }),
  }
  if (target.framework && !target.static) delete settings.MACH_O_TYPE
  return settings
}

const configurationsOf = (native) => native.buildConfigurationList.buildConfigurations
function setAll(native, key, value) {
  for (const configuration of configurationsOf(native)) configuration.buildSettings[key] = value
}

// A resource bundle is a target of its own, by its name. CocoaPods makes one of each spec that has the name,
// both under one id, and warns of the project it then writes; here it is refused.
function addBundles(project, target, context) {
  const bundles = []
  const named = target.accessors.flatMap((accessor) => Object.keys(accessor.resourceBundles).map((name) => [name, accessor.spec.name]))
  const [twice] = named.find(([name], at) => named.findIndex(([other]) => other === name) !== at) ?? []
  if (twice !== undefined) {
    const specs = named.filter(([name]) => name === twice).map(([, spec]) => spec)
    throw new PodError(`the resource bundle ${quote(twice)} is of more than one of its specs, ${specs.join(' and ')}, which CocoaPods writes no sound project for: two targets of one id`, target.where)
  }
  for (const accessor of target.accessors) {
    for (const [name, paths] of Object.entries(accessor.resourceBundles)) {
      const bundle = newTarget(project, `${target.label}-${name}`, 'bundle', `${name}.bundle`, {}, undefined)
      const { compiled, copied } = resourceRefs(project, target, paths)
      for (const ref of [...copied, ...compiled]) addFile(bundle, 'Resources', ref)
      const plist = `ResourceBundle-${name}-${target.label}-Info.plist`
      context.write(target, plist, context.support.infoPlist(target.version, 'BNDL'))
      for (const configuration of configurationsOf(bundle)) {
        Object.assign(configuration.buildSettings, {
          IPHONEOS_DEPLOYMENT_TARGET: target.platform.target,
          INFOPLIST_FILE: `Target Support Files/${target.label}/${plist}`,
          PRODUCT_NAME: name,
          CONFIGURATION_BUILD_DIR: `$(BUILD_DIR)/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)/${target.label}`,
          IBSC_MODULE: target.moduleName,
          CODE_SIGNING_ALLOWED: 'NO',
          TARGETED_DEVICE_FAMILY: '1,2',
        })
        for (const key of Object.keys(target.settings.merged)) delete configuration.buildSettings[key]
      }
      bundles.push(bundle)
    }
  }
  return bundles
}

// The script phases of a pod's own, each `[CP-User] <name>`, put where its podspec says, and the one that
// copies its .xcframeworks' slices, before its headers.
function addScriptPhases(native, target, context) {
  const move = (phase, kind, before) => {
    const at = native.buildPhases.findIndex((one) => one.isa === `PBX${kind}BuildPhase`)
    const from = native.buildPhases.indexOf(phase)
    if (at === -1 || (before ? from < at : from > at)) return
    native.buildPhases.splice(from, 1)
    native.buildPhases.splice(at, 0, phase)
  }
  const xcframeworks = target.settings.xcframeworks
  if (xcframeworks.length > 0) {
    const support = `\${PODS_ROOT}/Target Support Files/${target.label}/${target.label}-xcframeworks`
    const fromSandbox = (one) => posix.join(target.sandboxPath, posix.relative(target.dir, one.dir))
    context.addSupport(`${target.label}-xcframeworks.sh`, context.support.xcframeworksScript(xcframeworks, fromSandbox))
    const inputs = [`${support}.sh`, ...xcframeworks.map((one) => `\${PODS_ROOT}/${fromSandbox(one)}`)]
    const outputs = xcframeworks.map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/${one.name}.framework`)
    const phase = newPhase('ShellScript', { name: '[CP] Copy XCFrameworks', shellPath: '/bin/sh', shellScript: `"${support}.sh"\n`, showEnvVarsInLog: '0', ...context.paths(target, `${target.label}-xcframeworks`, inputs, outputs) })
    native.buildPhases.push(phase)
    move(phase, 'Headers', true)
  }
  for (const script of target.consumers.flatMap((consumer) => consumer.script_phases)) {
    const optional = { inputPaths: script.input_files, outputPaths: script.output_files, inputFileListPaths: script.input_file_lists, outputFileListPaths: script.output_file_lists, dependencyFile: script.dependency_file, alwaysOutOfDate: script.always_out_of_date }
    const phase = newPhase('ShellScript', { name: `[CP-User] ${script.name}`, shellPath: script.shell_path ?? '/bin/sh', shellScript: script.script })
    for (const [key, value] of Object.entries(optional)) if (value !== undefined && value !== null) phase[key] = value
    if (script.show_env_vars_in_log === '0') phase.showEnvVarsInLog = '0'
    native.buildPhases.push(phase)
    const position = script.execution_position
    if (position !== 'any') move(phase, position.endsWith('compile') ? 'Sources' : 'Headers', position.startsWith('before'))
  }
}

// PodTargetInstaller#add_swift_library_compatibility_header_phase: a Swift library's generated header, put
// where those that import the library find it, with a module map that names it.
function compatibilityHeaderPhase(target) {
  if (target.accessors.some((accessor) => accessor.moduleMap !== undefined)) throw new PodError('a Swift pod built as a static library with a module map of its own is not supported, as CocoaPods refuses it', target.where)
  const moduleMap = `\${PODS_ROOT}/${target.moduleMapLink}`
  const umbrella = `\${PODS_ROOT}/${posix.join(posix.dirname(target.moduleMapLink), `${target.label}-umbrella.h`)}`
  const generated = '${DERIVED_SOURCES_DIR}/${PRODUCT_MODULE_NAME}-Swift.h'
  const shellScript = [
    'COMPATIBILITY_HEADER_PATH="${BUILT_PRODUCTS_DIR}/Swift Compatibility Header/${PRODUCT_MODULE_NAME}-Swift.h"',
    'MODULE_MAP_PATH="${BUILT_PRODUCTS_DIR}/${PRODUCT_MODULE_NAME}.modulemap"',
    '',
    `ditto "${generated}" "\${COMPATIBILITY_HEADER_PATH}"`,
    `ditto "${moduleMap}" "\${MODULE_MAP_PATH}"`,
    `ditto "${umbrella}" "\${BUILT_PRODUCTS_DIR}"`,
    'printf "\\n\\nmodule ${PRODUCT_MODULE_NAME}.Swift {\\n  header \\"${COMPATIBILITY_HEADER_PATH}\\"\\n  requires objc\\n}\\n" >> "${MODULE_MAP_PATH}"',
    '',
  ].join('\n')
  return newPhase('ShellScript', {
    name: 'Copy generated compatibility header',
    inputFileListPaths: [],
    inputPaths: [generated, moduleMap, umbrella],
    outputFileListPaths: [],
    outputPaths: ['${BUILT_PRODUCTS_DIR}/${PRODUCT_MODULE_NAME}.modulemap', `\${BUILT_PRODUCTS_DIR}/${target.label}-umbrella.h`, '${BUILT_PRODUCTS_DIR}/Swift Compatibility Header/${PRODUCT_MODULE_NAME}-Swift.h'],
    shellPath: '/bin/sh',
    shellScript,
  })
}

// One pod's target. `context` writes its support files, and has the text of each, support.js's.
export function addPodTarget(project, target, context) {
  const { support } = context
  const addSupport = (name, text) => {
    context.write(target, name, text)
    return newFile(project, target.supportGroup, join(target.supportGroup._real, name))
  }
  const settings = targetSettings(target, project, context.objectVersion)
  if (!target.shouldBuild) {
    const placeholder = newAggregateTarget(project, target.label, { ENABLE_USER_SCRIPT_SANDBOXING: 'NO', ...(settings.ARCHS === undefined ? {} : { ARCHS: settings.ARCHS }) }, target.platform.target)
    // A pod with nothing to build has its resource bundles built all the same, each a target of its own.
    const bundles = addBundles(project, target, { ...context, write: (one, name, text) => addSupport(name, text) })
    addScriptPhases(placeholder, target, { ...context, addSupport })
    return finish(project, target, placeholder, bundles, addSupport)
  }
  const native = newTarget(project, target.label, target.framework ? 'framework' : 'static_library', target.productName, settings, target.platform.target)
  if (target.framework) addSystemFramework(project, native, 'Foundation')
  for (const configuration of configurationsOf(native)) for (const key of Object.keys(target.settings.merged)) delete configuration.buildSettings[key]
  const bundles = addBundles(project, target, { ...context, write: (one, name, text) => addSupport(name, text) })
  addSources(project, native, target)
  if (target.writesModuleMap) {
    const custom = target.customModuleMap
    addSupport(`${target.label}.modulemap`, custom === undefined ? support.moduleMap(target) : context.read(target, custom, !target.framework))
    setAll(native, 'MODULEMAP_FILE', target.moduleMapLink)
    if (custom === undefined) addFile(native, 'Headers', addSupport(`${target.label}-umbrella.h`, support.umbrellaHeader(target, support.umbrellaImports(target))), { ATTRIBUTES: [target.framework ? 'Public' : 'Project'] })
  }
  if (target.framework) {
    addSupport(`${target.label}-Info.plist`, support.infoPlist(target.version, 'FMWK', target.root.infoPlist))
    setAll(native, 'INFOPLIST_FILE', `Target Support Files/${target.label}/${target.label}-Info.plist`)
    if (target.consumers.some((consumer) => consumer.header_mappings_dir)) native.buildPhases.push(newPhase('ShellScript', { name: 'Create Symlinks to Header Folders', inputFileListPaths: [], inputPaths: [], outputFileListPaths: [], outputPaths: [], shellPath: '/bin/sh', shellScript: SYMLINK_HEADERS }))
  }
  if (!target.framework && target.usesSwift) native.buildPhases.push(compatibilityHeaderPhase(target))
  if (target.consumers.every((consumer) => consumer.prefix_header_file !== false)) {
    addSupport(`${target.label}-prefix.pch`, support.prefixHeader(target))
    setAll(native, 'GCC_PREFIX_HEADER', `Target Support Files/${target.label}/${target.label}-prefix.pch`)
  }
  addFile(native, 'Sources', addSupport(`${target.label}-dummy.m`, support.dummySource(target.label)))
  addScriptPhases(native, target, { ...context, addSupport })
  return finish(project, target, native, bundles, addSupport)
}

// The .xcconfig of each kind of configuration, which the target and its bundles' are based on.
function finish(project, target, native, bundles, addSupport) {
  const text = target.configText
  const refs = Object.fromEntries([...new Set(Object.values(project.configurations))].map((type) => [type, addSupport(`${target.label}.${type}.xcconfig`, text)]))
  for (const one of [native, ...bundles]) for (const configuration of configurationsOf(one)) configuration.baseConfigurationReference = refs[project.configurations[configuration.name]]
  target.native = native
  target.bundles = bundles
  return native
}
