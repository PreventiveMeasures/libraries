// An app target's Pods target in the Pods project, as AggregateTargetInstaller adds it: what the app links, with
// its support files; and the dependencies between targets.

import { join } from 'node:path'

import { addDependency, addFile, addSystemFramework, configurationsOf, newFile, newGroup, newTarget, setAll, targetDefaults } from './project.js'
import { COMPILED } from './project-resources.js'
import { BUILD_DIR, XCFRAMEWORKS_DIR } from './settings.js'
import * as support from './support.js'
import { configText } from './xcconfig.js'

const extensionOf = (path) => /\.[^./]+$/u.exec(path)?.[0] ?? ''
const fileName = (path) => path.split('/').at(-1)

// PodTarget#resource_paths, as AggregateTarget#resource_paths_by_config takes them. Of a static framework, a
// compiled resource is where its build leaves it: CocoaPods asks how the pod is built, not whether it is.
function resourcePaths(pod) {
  if (pod.shouldBuild && pod.framework && !pod.static) return []
  const paths = pod.accessors.flatMap((accessor) => [
    ...accessor.resources.map((path) => `\${PODS_ROOT}/${join(pod.sandboxPath, path)}`),
    ...Object.keys(accessor.resourceBundles).map((name) => `${BUILD_DIR}/${pod.label}/${name}.bundle`),
  ])
  if (!pod.framework || !pod.static) return [...new Set(paths)]
  return [...new Set(paths.map((path) => {
    const extension = extensionOf(path)
    if (COMPILED[extension] === undefined) return path
    const parts = [...path.split('/').filter((part) => extensionOf(part) === '.lproj'), fileName(path).slice(0, -extension.length) + COMPILED[extension]]
    return `\${BUILT_PRODUCTS_DIR}/${pod.label}/${pod.productName}/${parts.join('/')}`
  }))]
}

// PodTarget#framework_paths: of each spec, its vended dynamic libraries and frameworks, then the pod's own
// framework where it is built as a dynamic one.
function frameworkPaths(pod) {
  const built = pod.shouldBuild && pod.framework && !pod.static ? [`\${BUILT_PRODUCTS_DIR}/${pod.label}/${pod.productName}`] : []
  return [...new Set(pod.settings.vendored.artifacts.flatMap((paths) => [...paths.map((path) => `\${PODS_ROOT}/${join(pod.sandboxPath, path)}`), ...built]))]
}
const dynamicXcframeworks = (pod) => pod.settings.xcframeworks.filter((one) => one.framework && one.dynamic)

const OUTPUT_EXTENSIONS = { ...COMPILED, '.xcassets': '.car' }
// TargetIntegrator.resource_output_paths.
function resourceOutputs(resources) {
  return [...new Set(resources.map((path) => {
    const extension = extensionOf(path)
    const name = extension === '.xcassets' ? 'Assets' : fileName(path).slice(0, fileName(path).length - extension.length)
    return `\${TARGET_BUILD_DIR}/\${UNLOCALIZED_RESOURCES_FOLDER_PATH}/${name}${OUTPUT_EXTENSIONS[extension] ?? extension}`
  }))]
}

// `context` is generate.js's.
export function addAggregateTarget(project, aggregate, context) {
  const settings = {
    ...targetDefaults(aggregate.platform.target, context.objectVersion),
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
  for (const configuration of configurationsOf(native)) configuration.baseConfigurationReference = addSupport(`${aggregate.label}.${configuration.name.replaceAll('/', '-').toLowerCase()}.xcconfig`, text)
  if (aggregate.framework) {
    addSupport(`${aggregate.label}-Info.plist`, support.infoPlist('1.0.0', 'FMWK'))
    setAll(native, 'INFOPLIST_FILE', `Target Support Files/${aggregate.label}/${aggregate.label}-Info.plist`)
  }
  if (aggregate.framework || aggregate.podTargets.some((pod) => pod.usesSwift)) {
    addSupport(`${aggregate.label}.modulemap`, support.moduleMap(aggregate))
    setAll(native, 'MODULEMAP_FILE', `Target Support Files/${aggregate.label}/${aggregate.label}.modulemap`)
    addFile(native, 'Headers', addSupport(`${aggregate.label}-umbrella.h`, support.umbrellaHeader(aggregate)), { ATTRIBUTES: [aggregate.framework ? 'Public' : 'Project'] })
  }
  // The input and output file lists of the app's script phase, for each of its configurations.
  const lists = (kind, inputs, outputs) => {
    if (Number(context.objectVersion) < 50) return
    const script = `\${PODS_ROOT}/Target Support Files/${aggregate.label}/${aggregate.label}-${kind}.sh`
    for (const name of Object.keys(project.configurations)) {
      context.write(aggregate, `${aggregate.label}-${kind}-${name}-input-files.xcfilelist`, [script, ...inputs].join('\n'))
      context.write(aggregate, `${aggregate.label}-${kind}-${name}-output-files.xcfilelist`, outputs.join('\n'))
    }
  }
  const configurations = Object.keys(project.configurations)
  const frameworks = [...new Set(aggregate.podTargets.flatMap(frameworkPaths))]
  const xcframeworks = aggregate.podTargets.flatMap(dynamicXcframeworks)
  if (frameworks.length + xcframeworks.length > 0 && !aggregate.requiresHostTarget) {
    const embedded = xcframeworks.map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/${one.name}.framework`)
    addSupport(`${aggregate.label}-frameworks.sh`, support.frameworksScript(configurations, [...frameworks, ...embedded]))
    const outputs = [...new Set(frameworks.map((path) => `\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}/${fileName(path)}`)), ...xcframeworks.map((one) => `\${TARGET_BUILD_DIR}/\${FRAMEWORKS_FOLDER_PATH}/${one.name}.framework`)]
    lists('frameworks', [...frameworks, ...xcframeworks.map((one) => `${XCFRAMEWORKS_DIR}/${one.targetName}/${one.name}.framework/${one.name}`)], outputs)
  }
  const resources = [...new Set(aggregate.podTargets.flatMap(resourcePaths))]
  if (resources.length > 0) {
    addSupport(`${aggregate.label}-resources.sh`, support.resourcesScript(configurations, resources, aggregate.platform.target))
    // CocoaPods puts no resources phase in a static library, and so writes no lists for one.
    if (aggregate.userTarget.productType !== 'static_library') lists('resources', resources, resourceOutputs(resources))
  }
  const { markdown, plist } = support.acknowledgements(aggregate.podTargets)
  addSupport(`${aggregate.label}-acknowledgements.markdown`, markdown)
  addSupport(`${aggregate.label}-acknowledgements.plist`, plist)
  addFile(native, 'Sources', addSupport(`${aggregate.label}-dummy.m`, support.dummySource(aggregate.label)))
  aggregate.native = native
  return native
}

// PodTargetDependencyInstaller and AggregateTargetDependencyInstaller: a pod's target depends on its resource
// bundles' and on the pods it depends on; an app's Pods target on every pod it takes.
export function wireDependencies(project, pods, aggregates) {
  for (const pod of pods) {
    // A dynamic framework carries its bundles as resources of its own.
    const dynamic = pod.shouldBuild && pod.framework && !pod.static
    for (const bundle of pod.bundles) {
      addDependency(project, pod.native, bundle)
      if (dynamic) addFile(pod.native, 'Resources', bundle.productReference)
    }
    for (const other of pod.dependencies) addDependency(project, pod.native, other.native)
  }
  for (const aggregate of aggregates) for (const pod of aggregate.podTargets) addDependency(project, aggregate.native, pod.native)
}
