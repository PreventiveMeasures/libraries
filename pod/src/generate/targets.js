// The targets CocoaPods' analyzer makes: one for each pod, of its specs installed, and one for each of the app's
// targets that takes pods. Each pod is built once, alike for every target.

import { extname } from 'node:path'

import { PodError, quote } from '../error.js'
import { byBytes, maxVersion } from '../order.js'
import { listPod } from '../pathlist.js'
import { accessorOf } from './files.js'
import { consumerOf, deploymentTarget, rootOf, specNamed, supports } from './spec.js'

function fail(detail, where) {
  throw new PodError(detail, where)
}


// The product types whose pods' frameworks their host embeds, and those of an app extension.
const HOSTED = new Set(['app_extension', 'framework', 'static_library', 'messages_extension', 'watch_extension', 'xpc_service'])
const EXTENSIONS = new Set(['app_extension', 'watch_extension', 'watch2_extension', 'tv_extension', 'messages_extension'])

// PodTarget#version: the first three numbers of the root's.
function shortVersion(version) {
  const numbers = String(version).split(/[.-]/u).filter((part) => /^\d+$/u.test(part)).slice(0, 3).map(Number)
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0].join('.')
}

// Analyzer#determine_platform.
function platformOf(specs, name, framework) {
  const targets = specs.map((spec) => deploymentTarget(spec, name) ?? '4.3')
  if (name === 'ios' && framework) targets.push('8.0')
  return { name, target: maxVersion(targets) }
}

// A pod's target, of load.js's `pod`; `options` is what the config says of it.
function podTarget(pod, platformName, options) {
  const where = `pods[${quote(pod.name)}]`
  const root = rootOf(pod.root, where)
  const specs = [...pod.specs].sort(byBytes).map((name) => specNamed(pod.root, name) ?? fail(`its podspec has no ${quote(name)}, which the lockfile installs`, where))
  for (const spec of specs) if (!supports(spec, platformName)) fail(`${quote(spec.name)} is not for ${platformName}`, where)
  // Analyzer#determine_build_type: a framework under `use_frameworks!`, static by it or by the podspec.
  const framework = options.linkage !== false
  const isStatic = !framework || options.linkage === 'static' || root.staticFramework
  const list = listPod(pod.dir, where)
  const consumers = specs.map((spec) => consumerOf(spec, platformName))
  const accessors = consumers.map((consumer) => accessorOf(list, consumer))
  const headers = new Set(accessors.flatMap((accessor) => accessor.headers))
  const shouldBuild = accessors.some((accessor) => accessor.sourceFiles.some((path) => !headers.has(path)))
  const usesSwift = (!shouldBuild && root.swiftVersions.length > 0) || accessors.some((accessor) => accessor.sourceFiles.some((path) => extname(path) === '.swift'))
  const definesModule = usesSwift || framework || options.modularHeaders || consumers.some((consumer) => consumer.pod_target_xcconfig.DEFINES_MODULE === 'YES')
  return {
    name: pod.name, label: pod.name, where, root, specs, consumers, accessors, list, framework, shouldBuild, usesSwift, definesModule,
    static: isStatic,
    platform: platformOf(specs, platformName, framework),
    version: shortVersion(root.version),
    swiftVersion: root.swiftVersions.length === 0 ? options.swiftVersions[0] : maxVersion(root.swiftVersions),
    inhibitWarnings: options.inhibitWarnings,
    local: pod.local,
    dir: pod.dir,
    sandboxPath: pod.sandboxPath,
    moduleName: root.moduleName,
    productBasename: framework ? root.moduleName : pod.name,
    productName: framework ? `${root.moduleName}.framework` : `lib${pod.name}.a`,
    // uses_modular_headers?(false): no spec maps its headers into directories.
    plainHeaders: consumers.every((consumer) => !consumer.header_mappings_dir && !consumer.header_dir),
    dependencyNames: [...new Set(consumers.flatMap((consumer) => consumer.dependencies.map((name) => name.split('/')[0])))].filter((name) => name !== pod.name),
    extensionApiOnly: false,
  }
}

// Each target's dependencies, direct and all of them, the nearest first.
function wire(podTargets) {
  const byName = new Map(podTargets.map((target) => [target.name, target]))
  for (const target of podTargets) {
    target.dependencies = target.dependencyNames.map((name) => byName.get(name) ?? fail(`depends on ${quote(name)}, which the lockfile does not install`, target.where))
  }
  for (const target of podTargets) {
    const all = new Set()
    const add = (one) => {
      for (const dependency of one.dependencies) {
        if (dependency === target || all.has(dependency)) continue
        all.add(dependency)
        add(dependency)
      }
    }
    add(target)
    target.recursiveDependencies = [...all]
  }
}

// Analyzer#embedded_target_pod_targets_by_host: the pods of targets embedded in `host` that it has to have too.
// Under frameworks, those built dynamic, loaded from the host's bundle; else a static library's, which it links.
function embeddedPods(host, aggregates) {
  if (host.requiresHostTarget) return []
  const own = new Set(host.podTargets)
  const embedded = aggregates.filter((one) => one.requiresHostTarget && host.userTarget.dependencies.includes(one.userTarget.id) && (one.framework || one.userTarget.productType === 'static_library'))
  return [...new Set(embedded.flatMap((one) => one.podTargets.filter((target) => !own.has(target) && !(one.framework && target.static))))]
}

// `pods` are load.js's, `user` is user-project.js's, `config` config.js's. The pod targets come sorted by name,
// as CocoaPods installs them.
export function analyze(pods, user, config) {
  const platformName = config.platform.name
  const integrated = user.targets.filter((target) => target.label !== undefined)
  if (integrated.length === 0) fail('the app\'s project has no target that takes pods: none has a Pods-<name> xcconfig for its configurations')
  const swiftVersions = [...new Set(integrated.map((target) => target.swiftVersion).filter((version) => version !== undefined))]
  const podTargets = pods.map((pod) => podTarget(pod, platformName, {
    linkage: config.frameworks,
    swiftVersions,
    // TargetDefinition#build_pod_as_module? and #inhibits_warnings_for_pod?: what is said of the pod, else of all.
    modularHeaders: config.pods[pod.name]?.modularHeaders ?? config.modularHeaders,
    inhibitWarnings: config.pods[pod.name]?.inhibitWarnings ?? config.inhibitWarnings,
  })).sort((a, b) => byBytes(a.name, b.name))
  wire(podTargets)
  const byName = new Map(podTargets.map((target) => [target.name, target]))
  const aggregates = integrated.map((userTarget) => {
    const names = config.targets[userTarget.name]?.pods
    const roots = names === undefined ? podTargets : names.map((name) => byName.get(name) ?? fail(`takes the pod ${quote(name)}, which the lockfile does not install`, `targets[${quote(userTarget.name)}]`))
    const taken = new Set(roots.flatMap((target) => [target, ...target.recursiveDependencies]))
    const moduleName = userTarget.label.replace(/^(\d)/u, '_$1').replaceAll(/[^a-zA-Z0-9_]/gu, '_')
    const framework = config.frameworks !== false
    return {
      label: userTarget.label, userTarget, framework, moduleName,
      podTargets: podTargets.filter((target) => taken.has(target)),
      platform: { name: platformName, target: config.platform.target ?? userTarget.deploymentTarget },
      productName: framework ? `${moduleName}.framework` : `lib${userTarget.label}.a`,
      requiresHostTarget: HOSTED.has(userTarget.productType),
      swiftVersion: userTarget.swiftVersion,
    }
  }).sort((a, b) => byBytes(a.label, b.label))
  for (const aggregate of aggregates) {
    if (EXTENSIONS.has(aggregate.userTarget.productType) || aggregate.userTarget.extensionApiOnly) for (const target of aggregate.podTargets) target.extensionApiOnly = true
  }
  const embedded = new Map(aggregates.map((aggregate) => [aggregate, embeddedPods(aggregate, aggregates)]))
  for (const aggregate of aggregates) aggregate.podTargets = [...aggregate.podTargets, ...embedded.get(aggregate)]
  // TargetInspector#compute_build_configurations: the integrated targets' configurations, Debug as debug and
  // the rest as release.
  const configurations = Object.fromEntries(integrated.flatMap((target) => target.configurations).map((name) => [name, name === 'Debug' ? 'debug' : 'release']))
  return { podTargets, aggregates, configurations }
}
