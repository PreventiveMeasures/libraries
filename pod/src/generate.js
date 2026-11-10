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
import { newGroup, newProject, normalizeSettings, pathFrom, sortProject } from './project.js'
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

function prepare(target, targets) {
  target.headerLinks = headersOf(target)
  target.moduleMapLink = moduleMapLink(target)
  target.specTargets = new Map(target.specs.map((spec) => [spec, deploymentTarget(spec, target.platform.name)]))
  target.developerFiles = target.local ? developerFiles(target) : []
  target.settings = podSettings(target, targets)
}

function podfileRef(project, dir) {
  if (!existsSync(join(dir, 'Podfile'))) return
  project.mainGroup.children.push({ isa: 'PBXFileReference', explicitFileType: 'text.script.ruby', includeInIndex: '1', indentWidth: '2', lastKnownFileType: 'text', name: 'Podfile', path: pathFrom(project.dir, join(dir, 'Podfile')), sourceTree: 'SOURCE_ROOT', tabWidth: '2', xcLanguageSpecificationIdentifier: 'xcode.lang.ruby' })
}

// The links of Pods/Headers, each `[path, target]`, the target from the link's own directory.
function headerLinks(targets, sandbox) {
  const links = []
  for (const target of targets) {
    for (const [store, mappings] of [['Private', target.headerLinks.private], ['Public', target.headerLinks.public]]) {
      for (const [dir, headers] of mappings) for (const header of headers) links.push([posix.join('Headers', store, dir, posix.basename(header)), pathFrom(join(sandbox, 'Headers', store, dir), join(target.dir, header))])
    }
    if (target.shouldBuild && target.definesModule && !target.framework) {
      const dir = posix.dirname(target.moduleMapLink)
      for (const name of [`${target.label}.modulemap`, `${target.label}-umbrella.h`]) links.push([posix.join(dir, name), pathFrom(join(sandbox, dir), join(sandbox, 'Target Support Files', target.label, name))])
    }
  }
  return links
}

// `input` is load.js's. The files come by their paths from Pods/, each as text; the links as headerLinks'.
export function generate(input) {
  const { dir, sandbox, config, user } = input
  const { podTargets, aggregates, configurations } = analyze(input.pods, user, config)
  for (const target of podTargets) prepare(target, podTargets)
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
