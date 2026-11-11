// Stage 4: what `pod install` generates in Pods/ beside the pods: the Pods project, every target's support files
// and the header links, all worked out before anything is written.

import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { PodError } from '../error.js'
import { compareVersions } from '../order.js'
import { glob } from '../pathlist.js'
import { licenseOf } from './files.js'
import { headersOf } from './headers.js'
import { writeProject } from './pbxproj.js'
import { addAggregateTarget, wireDependencies } from './project-aggregate.js'
import { addPodFiles, addPodTarget } from './project-pods.js'
import { addSystemFramework, configurationsOf, newGroup, newProject, normalizeSettings, pathFrom, sortProject } from './project.js'
import { aggregateConfig } from './settings-aggregate.js'
import { podSettings } from './settings-pod.js'
import { deploymentTarget } from './spec.js'
import { analyze } from './targets.js'
import { configText } from './xcconfig.js'

// What load.js reads for this stage: a podspec's JSON as a spec, and the app's project.
export { readSpec } from './spec.js'
export { readUserProject } from './user-project.js'

// FileAccessor#developer_files of a local pod.
function developerFiles(target) {
  const { list } = target
  const podspecs = glob(list, ['*.{podspec,podspec.json}'])
  const own = target.accessors.flatMap((accessor) => [accessor.moduleMap, accessor.prefixHeader])
  const license = licenseOf(list, target.root.license)
  const rest = podspecs.length <= 1 ? [license, glob(list, ['readme{*,.*}'])[0], ...podspecs, ...glob(list, ['doc{s}{*,.*}/**/*'])] : [podspecs.find((path) => posix.basename(path, posix.extname(path)) === target.name), license]
  return [...new Set([...own, ...rest].filter((path) => path !== undefined))].sort()
}

// Where importers find a pod's module map: in its support files for a framework, else linked among its
// headers, the private ones where the pod brings its own.
function moduleMapLink(target) {
  if (target.framework) return `Target Support Files/${target.label}/${target.label}.modulemap`
  const store = target.accessors.some((accessor) => accessor.moduleMap !== undefined) ? 'Private' : 'Public'
  return `Headers/${store}/${target.moduleName}/${target.label}.modulemap`
}

// PodTargetInstaller#install!: a module map is written for a built target that defines a module unless a spec
// says none is, and an umbrella header with it unless the module map is the pod's own.
function prepare(target, targets) {
  target.headerLinks = headersOf(target)
  target.moduleMapLink = moduleMapLink(target)
  target.customModuleMap = target.accessors.map((accessor) => accessor.moduleMap).find((path) => path !== undefined)
  target.writesModuleMap = target.shouldBuild && target.definesModule && target.consumers.every((consumer) => consumer.module_map !== false)
  target.specTargets = new Map(target.specs.map((spec) => [spec, deploymentTarget(spec, target.platform.name)]))
  target.developerFiles = target.local ? developerFiles(target) : []
  target.settings = podSettings(target, targets)
}

function podfileRef(project, dir) {
  if (!existsSync(join(dir, 'Podfile'))) return
  project.mainGroup.children.push({ isa: 'PBXFileReference', explicitFileType: 'text.script.ruby', includeInIndex: '1', indentWidth: '2', lastKnownFileType: 'text', name: 'Podfile', path: pathFrom(project.dir, join(dir, 'Podfile')), sourceTree: 'SOURCE_ROOT', tabWidth: '2', xcLanguageSpecificationIdentifier: 'xcode.lang.ruby' })
}

// The links of Pods/Headers as `[path, target]`. Where several headers come to one path, the last is linked, as
// CocoaPods' `ln -sf` of each in turn leaves it. A library's module map and umbrella header link where written.
function headerLinks(targets, sandbox) {
  const links = new Map()
  for (const target of targets) {
    for (const [store, mappings] of [['Private', target.headerLinks.private], ['Public', target.headerLinks.public]]) {
      for (const [dir, headers] of mappings) for (const header of headers) links.set(posix.join('Headers', store, dir, posix.basename(header)), pathFrom(join(sandbox, 'Headers', store, dir), join(target.dir, header)))
    }
    if (target.writesModuleMap && !target.framework) {
      const dir = posix.dirname(target.moduleMapLink)
      for (const name of [`${target.label}.modulemap`, ...(target.customModuleMap === undefined ? [`${target.label}-umbrella.h`] : [])]) links.set(posix.join(dir, name), pathFrom(join(sandbox, dir), join(sandbox, 'Target Support Files', target.label, name)))
    }
  }
  return [...links]
}

// TargetValidator#verify_no_static_framework_transitive_dependencies: nothing under a pod built as a dynamic
// framework may be linked statically, neither vendored binaries nor pods built static.
function checkStaticDependencies(aggregates) {
  for (const aggregate of aggregates) {
    const dynamic = aggregate.podTargets.filter((target) => target.shouldBuild && !target.static)
    const under = new Set(dynamic.flatMap((target) => target.dependencies))
    const binaries = aggregate.podTargets.filter((target) => !target.shouldBuild && under.has(target)).flatMap(({ settings }) => [
      ...settings.vendored.staticFrameworks, ...settings.vendored.staticLibraries, ...settings.xcframeworks.filter((one) => !one.dynamic).map((one) => one.name),
    ])
    const built = [...new Set(dynamic.flatMap((target) => target.recursiveDependencies))].filter((target) => target.static).map((target) => target.name)
    const found = binaries.length > 0 ? binaries : built
    if (found.length > 0) throw new PodError(`has transitive dependencies that include statically linked binaries: ${found.join(', ')}`, `targets[${JSON.stringify(aggregate.userTarget.name)}]`)
  }
}

// TargetIntegrator's EMBED_FRAMEWORK_TARGET_TYPES, by user-project.js's names where it has them.
const EMBEDS = new Set(['application', 'unit_test_bundle', 'ui_test_bundle', 'watch2_extension', 'com.apple.product-type.application.on-demand-install-capable', 'com.apple.product-type.application.messages'])

// The app's project is not changed, so its phases must already be as CocoaPods would integrate them: none runs a
// resources or frameworks script that is not written, and each written one runs where CocoaPods adds its phase.
function checkIntegration(aggregates, files) {
  for (const { label, userTarget } of aggregates) {
    const where = `targets[${JSON.stringify(userTarget.name)}]`
    const again = 'the project is integrated for other pods than the lockfile has, and has to be integrated again'
    const phased = { resources: userTarget.productType !== 'static_library', frameworks: EMBEDS.has(userTarget.productType) }
    for (const [kind, what] of [['resources', 'resources to copy'], ['frameworks', 'frameworks to embed']]) {
      const path = `${label}/${label}-${kind}.sh`
      const [written, run] = [files.has(`Target Support Files/${path}`), userTarget.scripts.includes(path)]
      if (run && !written) throw new PodError(`a phase of it in the app's project runs ${label}-${kind}.sh, which its pods have no more use for and is not written: ${again}, or the phase taken out of it`, where)
      if (written && !run && phased[kind]) throw new PodError(`its pods have ${what}, and no phase of it in the app's project runs ${label}-${kind}.sh, which does it: ${again}`, where)
    }
  }
}

// `input` is load.js's. Returns the files by their paths from Pods/, and the links as headerLinks'.
export function generate(input) {
  const { dir, sandbox, config, user } = input
  const { podTargets, aggregates, configurations } = analyze(input.pods, user, config)
  for (const target of podTargets) prepare(target, podTargets)
  checkStaticDependencies(aggregates)
  for (const target of podTargets) target.configText = configText(target.settings.config)
  const lowest = aggregates.map((aggregate) => aggregate.platform.target).reduce((least, target) => (compareVersions(target, least) < 0 ? target : least))
  if (lowest === undefined) throw new PodError('no deployment target is given, by `platform` or by the app\'s targets', 'pod.config.json')
  const project = newProject(sandbox, configurations, user.objectVersion, lowest)
  project.supportFiles = newGroup(project.mainGroup, 'Targets Support Files')
  project.pods = newGroup(project.mainGroup, 'Pods')
  project.developmentPods = newGroup(project.mainGroup, 'Development Pods')
  podfileRef(project, dir)
  const files = new Map()
  const context = {
    sandbox,
    objectVersion: user.objectVersion,
    write: (target, name, text) => files.set(`Target Support Files/${target.label}/${name}`, text),
    read: (target, path, plain) => {
      const text = readFileSync(join(target.dir, path), 'utf8')
      return plain ? text.replaceAll(/^(\s*)framework\s+(module[^{}]+)\{/gmu, '$1$2{') : text
    },
    config: (aggregate) => aggregateConfig(aggregate, { podfileDir: pathFrom(user.dir, dir), podsDir: pathFrom(user.dir, sandbox), pods: podTargets }),
    paths: (target, base, inputs, outputs) => {
      if (Number(user.objectVersion) < 50) return { inputPaths: inputs, outputPaths: outputs }
      const lists = { inputFileListPaths: [`${base}-input-files.xcfilelist`, inputs], outputFileListPaths: [`${base}-output-files.xcfilelist`, outputs] }
      for (const [name, paths] of Object.values(lists)) files.set(`Target Support Files/${target.label}/${name}`, paths.join('\n'))
      return Object.fromEntries(Object.entries(lists).map(([key, [name]]) => [key, [`\${PODS_ROOT}/Target Support Files/${target.label}/${name}`]]))
    },
  }
  for (const target of podTargets) addPodFiles(project, target, sandbox)
  for (const target of podTargets) addPodTarget(project, target, context)
  // PodsProjectGenerator#add_system_framework_dependencies: a dynamic framework links its podspec's system
  // frameworks itself; a static one leaves them to the app.
  for (const target of podTargets.filter((one) => one.shouldBuild && !one.static)) {
    for (const name of target.consumers.flatMap((consumer) => consumer.frameworks)) addSystemFramework(project, target.native, name)
  }
  for (const aggregate of aggregates) addAggregateTarget(project, aggregate, context)
  checkIntegration(aggregates, files)
  wireDependencies(project, podTargets, aggregates)
  // What a post_install hook set, on every target and on a pod's own.
  for (const target of project.targets) {
    for (const configuration of configurationsOf(target)) Object.assign(configuration.buildSettings, config.buildSettings, config.pods[target.name]?.buildSettings)
  }
  // CocoaPods removes its own groups where empty; Xcodeproj's Frameworks group stays.
  project.frameworks ??= newGroup(project.mainGroup, 'Frameworks')
  const own = new Set([project.supportFiles, project.pods, project.developmentPods])
  project.mainGroup.children = project.mainGroup.children.filter((child) => !own.has(child) || child.children.length > 0)
  sortProject(project)
  normalizeSettings(project)
  files.set('Pods.xcodeproj/project.pbxproj', writeProject(project))
  for (const pod of input.pods) if (pod.external) files.set(`Local Podspecs/${pod.name}.podspec.json`, pod.bytes)
  files.set('Manifest.lock', input.lockText)
  return { files, links: headerLinks(podTargets, sandbox), podTargets, aggregates, project }
}
