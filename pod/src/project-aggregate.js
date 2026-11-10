// An app target's Pods target in the Pods project, as CocoaPods' AggregateTargetInstaller puts it there: what
// the app links, depending on every pod it takes, with its support files; and what each target depends on.

import { join } from 'node:path'

import { addDependency, addFile, addSystemFramework, newFile, newGroup, newTarget, only64Bit } from './project.js'
import { BUILD_DIR, XCFRAMEWORKS_DIR } from './settings.js'
import { configText } from './xcconfig.js'

const COMPILED = { '.storyboard': '.storyboardc', '.xib': '.nib', '.xcdatamodel': '.mom', '.xcdatamodeld': '.momd', '.xcmappingmodel': '.cdm' }
const extensionOf = (path) => /\.[^./]+$/u.exec(path)?.[0] ?? ''

// PodTarget#resource_paths, as AggregateTarget#resource_paths_by_config takes them: a pod's resources from
// Pods/, a compiled one of a static framework where its build leaves it, and each of its bundles.
function resourcePaths(pod) {
  if (pod.shouldBuild && pod.framework && !pod.static) return []
  const paths = pod.accessors.flatMap((accessor) => [
    ...accessor.resources.map((path) => `\${PODS_ROOT}/${join(pod.sandboxPath, path)}`),
    ...Object.keys(accessor.resourceBundles).map((name) => `${BUILD_DIR}/${pod.label}/${name}.bundle`),
  ])
  if (!pod.framework) return [...new Set(paths)]
  return [...new Set(paths.map((path) => {
    const extension = extensionOf(path)
    if (COMPILED[extension] === undefined) return path
    const parts = [...path.split('/').filter((part) => extensionOf(part) === '.lproj'), path.split('/').at(-1).slice(0, -extension.length) + COMPILED[extension]]
    return `\${BUILT_PRODUCTS_DIR}/${pod.label}/${pod.productName}/${parts.join('/')}`
  }))]
}

// What the app embeds: each pod's dynamic frameworks as they are vended, and the one it is built as; and its
// dynamic .xcframeworks, whose slice for the build is copied where the app takes it from.
function frameworkPaths(pod) {
  const vendored = pod.settings.vendored.dynamicFrameworks.map((path) => `\${PODS_ROOT}/${join(pod.sandboxPath, path)}`)
  const built = pod.shouldBuild && pod.framework && !pod.static ? [`\${BUILT_PRODUCTS_DIR}/${pod.label}/${pod.productName}`] : []
  return [...new Set([...vendored, ...built])]
}
const dynamicXcframeworks = (pod) => pod.settings.xcframeworks.filter((one) => one.framework && one.dynamic)

const OUTPUT_EXTENSIONS = { ...COMPILED, '.xcassets': '.car' }
// TargetIntegrator.resource_output_paths: where the resources script leaves each resource in the app.
function resourceOutputs(resources) {
  return [...new Set(resources.map((path) => {
    const extension = extensionOf(path)
    const name = extension === '.xcassets' ? 'Assets' : path.split('/').at(-1).slice(0, path.split('/').at(-1).length - extension.length)
    return `\${TARGET_BUILD_DIR}/\${UNLOCALIZED_RESOURCES_FOLDER_PATH}/${name}${OUTPUT_EXTENSIONS[extension] ?? extension}`
  }))]
}

const byConfiguration = (project, value) => Object.fromEntries(Object.keys(project.configurations).map((name) => [name, value]))

// `context` writes the support files, and has support.js's texts and the aggregate's .xcconfig.
export function addAggregateTarget(project, aggregate, context) {
  const { support } = context
  const settings = {
    ...(only64Bit(aggregate.platform.target, context.objectVersion) ? { ARCHS: '$(ARCHS_STANDARD_64_BIT)' } : {}),
    ENABLE_USER_SCRIPT_SANDBOXING: 'NO',
    ENABLE_MODULE_VERIFIER: 'NO',
    'CODE_SIGN_IDENTITY[sdk=appletvos*]': '',
    'CODE_SIGN_IDENTITY[sdk=iphoneos*]': '',
    'CODE_SIGN_IDENTITY[sdk=watchos*]': '',
    MACH_O_TYPE: 'staticlib',
    OTHER_LDFLAGS: '',
    OTHER_LIBTOOLFLAGS: '',
    PODS_ROOT: '$(SRCROOT)',
    PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.${PRODUCT_NAME:rfc1034identifier}',
    SKIP_INSTALL: 'YES',
    ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: 'NO',
  }
  const native = newTarget(project, aggregate.label, aggregate.framework ? 'framework' : 'static_library', aggregate.productName, settings, aggregate.platform.target)
  if (aggregate.framework) addSystemFramework(project, native, 'Foundation')
  const dir = join(context.sandbox, 'Target Support Files', aggregate.label)
  const group = newGroup(project.supportFiles, aggregate.label, dir)
  const addSupport = (name, text) => {
    context.write(aggregate, name, text)
    return newFile(project, group, join(dir, name))
  }
  const text = configText(context.config(aggregate))
  for (const configuration of native.buildConfigurationList.buildConfigurations) configuration.baseConfigurationReference = addSupport(`${aggregate.label}.${configuration.name.replaceAll('/', '-').toLowerCase()}.xcconfig`, text)
  const setAll = (key, value) => {
    for (const configuration of native.buildConfigurationList.buildConfigurations) configuration.buildSettings[key] = value
  }
  if (aggregate.framework) {
    addSupport(`${aggregate.label}-Info.plist`, support.infoPlist('1.0.0', 'FMWK'))
    setAll('INFOPLIST_FILE', `Target Support Files/${aggregate.label}/${aggregate.label}-Info.plist`)
  }
  if (aggregate.framework || aggregate.podTargets.some((pod) => pod.usesSwift)) {
    addSupport(`${aggregate.label}.modulemap`, support.moduleMap(aggregate))
    setAll('MODULEMAP_FILE', `Target Support Files/${aggregate.label}/${aggregate.label}.modulemap`)
    addFile(native, 'Headers', addSupport(`${aggregate.label}-umbrella.h`, support.umbrellaHeader(aggregate)), { ATTRIBUTES: [aggregate.framework ? 'Public' : 'Project'] })
  }
  // The lists of what the app's own script phases read and write, one for each of its configurations.
  const lists = (kind, inputs, outputs) => {
    if (Number(context.objectVersion) < 50) return
    const script = `\${PODS_ROOT}/Target Support Files/${aggregate.label}/${aggregate.label}-${kind}.sh`
    for (const name of Object.keys(project.configurations)) {
      context.write(aggregate, `${aggregate.label}-${kind}-${name}-input-files.xcfilelist`, [script, ...inputs].join('\n'))
      context.write(aggregate, `${aggregate.label}-${kind}-${name}-output-files.xcfilelist`, outputs.join('\n'))
    }
  }
  const frameworks = [...new Set(aggregate.podTargets.flatMap(frameworkPaths))]
  const xcframeworks = aggregate.podTargets.flatMap(dynamicXcframeworks)
  const embedded = xcframeworks.map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/${one.name}.framework`)
  if (frameworks.length + xcframeworks.length > 0 && !aggregate.requiresHostTarget) {
    addSupport(`${aggregate.label}-frameworks.sh`, support.frameworksScript(byConfiguration(project, [...frameworks, ...embedded])))
    const outputs = [...new Set(frameworks.map((path) => `\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}/${path.split('/').at(-1)}`)), ...xcframeworks.map((one) => `\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}/${one.name}.framework`)]
    lists('frameworks', [...frameworks, ...xcframeworks.map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/${one.name}.framework/${one.name}`)], outputs)
  }
  const resources = [...new Set(aggregate.podTargets.flatMap(resourcePaths))]
  if (resources.length > 0) {
    addSupport(`${aggregate.label}-resources.sh`, support.resourcesScript(byConfiguration(project, resources), aggregate.platform.target))
    lists('resources', resources, resourceOutputs(resources))
  }
  const { markdown, plist } = support.acknowledgements(aggregate.podTargets)
  addSupport(`${aggregate.label}-acknowledgements.markdown`, markdown)
  addSupport(`${aggregate.label}-acknowledgements.plist`, plist)
  addFile(native, 'Sources', addSupport(`${aggregate.label}-dummy.m`, support.dummySource(aggregate.label)))
  aggregate.native = native
  return native
}

// PodTargetDependencyInstaller and AggregateTargetDependencyInstaller: a pod's target depends on its resource
// bundles' and on those of the pods it depends on itself; an app's Pods target on every pod it takes.
export function wireDependencies(project, pods, aggregates) {
  for (const pod of pods) {
    for (const bundle of pod.bundles) addDependency(project, pod.native, bundle)
    for (const other of pod.dependencies) addDependency(project, pod.native, other.native)
  }
  for (const aggregate of aggregates) for (const pod of aggregate.podTargets) addDependency(project, aggregate.native, pod.native)
}
