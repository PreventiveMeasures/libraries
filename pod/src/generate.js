// What `pod install` generates in Pods/ beside the pods themselves: the Pods project, every target's support
// files, and the links to the headers; all of it worked out before any of it is written.

import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { PodError } from './error.js'
import { glob, licenseOf } from './files.js'
import { headersOf } from './headers.js'
import { writeProject } from './pbxproj.js'
import { addAggregateTarget, wireDependencies } from './project-aggregate.js'
import { addPodFiles, addPodTarget } from './project-pods.js'
import { addSystemFramework, newGroup, newProject, normalizeSettings, pathFrom, sortProject } from './project.js'
import { aggregateConfig } from './settings-aggregate.js'
import { podSettings } from './settings-pod.js'
import { deploymentTarget } from './spec.js'
import * as support from './support.js'
import { analyze, compareVersions } from './targets.js'
import { configText } from './xcconfig.js'

// FileAccessor#developer_files of a local pod: what its group shows beside its sources.
function developerFiles(target) {
  const { list } = target
  const podspecs = glob(list, ['*.{podspec,podspec.json}'])
  const own = target.accessors.flatMap((accessor) => [accessor.moduleMap, accessor.prefixHeader])
  const license = licenseOf(list, target.root.license)
  const rest = podspecs.length <= 1 ? [license, glob(list, ['readme{*,.*}'])[0], ...podspecs, ...glob(list, ['doc{s}{*,.*}/**/*'])] : [podspecs.find((path) => posix.basename(path, posix.extname(path)) === target.name), license]
  return [...new Set([...own, ...rest].filter((path) => path !== undefined))].sort()
}

// Where a pod's module map is found by those that import it: with its support files where it is a framework,
// else linked among its headers, the private ones where it brings its own.
function moduleMapLink(target) {
  if (target.framework) return `Target Support Files/${target.label}/${target.label}.modulemap`
  const store = target.accessors.some((accessor) => accessor.moduleMap !== undefined) ? 'Private' : 'Public'
  return `Headers/${store}/${target.moduleName}/${target.label}.modulemap`
}

// PodTargetInstaller#install!: a module map is written for a target that is built and defines a module, unless
// a spec of it says none is; and an umbrella header with it, unless the module map is the pod's own.
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

// The links of Pods/Headers, each `[path, target]`, the target from the link's own directory. A path is linked
// once: where more than one header comes to it, of two subspecs that both have the header or of two headers of
// one name, the last does, as CocoaPods' `ln -sf` of each in turn leaves it. A library's module map and its
// umbrella header are linked where they are written, and not where they are not.
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

// TargetValidator#verify_no_static_framework_transitive_dependencies: a pod built as a dynamic framework may
// have nothing linked statically under it, which would be in it and in whatever else has it too. CocoaPods
// refuses the installation, and so is it refused here: a pod of binaries that are static, or one built static.
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

// `input` is load.js's. The files come by their paths from Pods/, each as text; the links as headerLinks'.
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
    support,
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
  // PodsProjectGenerator#add_system_framework_dependencies: a pod built as a dynamic framework is linked with
  // the frameworks of the system its podspec names, which a static one leaves to the app.
  for (const target of podTargets.filter((one) => one.shouldBuild && !one.static)) {
    for (const name of target.consumers.flatMap((consumer) => consumer.frameworks)) addSystemFramework(project, target.native, name)
  }
  for (const aggregate of aggregates) addAggregateTarget(project, aggregate, context)
  wireDependencies(project, podTargets, aggregates)
  // What a post_install hook set: on every target of the project, and on one pod's own.
  for (const target of project.targets) {
    for (const configuration of target.buildConfigurationList.buildConfigurations) Object.assign(configuration.buildSettings, config.buildSettings, config.pods[target.name]?.buildSettings)
  }
  // CocoaPods removes its own groups where they hold nothing; Xcodeproj's Frameworks stays, as it is asked for.
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
