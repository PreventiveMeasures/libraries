// The app's Xcode project as `pod install` integrated it: which targets take pods, by the Pods-<name> xcconfig
// their configurations are based on, and what CocoaPods' analyzer reads of each.

import { basename } from 'node:path'

import { PodError, quote } from '../error.js'
import { parseAscii } from './plist.js'

const PRODUCT_TYPES = {
  'com.apple.product-type.application': 'application',
  'com.apple.product-type.app-extension': 'app_extension',
  'com.apple.product-type.app-extension.messages': 'messages_extension',
  'com.apple.product-type.framework': 'framework',
  'com.apple.product-type.library.static': 'static_library',
  'com.apple.product-type.library.dynamic': 'dynamic_library',
  'com.apple.product-type.bundle': 'bundle',
  'com.apple.product-type.bundle.unit-test': 'unit_test_bundle',
  'com.apple.product-type.bundle.ui-testing': 'ui_test_bundle',
  'com.apple.product-type.watchkit-extension': 'watch_extension',
  'com.apple.product-type.watchkit2-extension': 'watch2_extension',
  'com.apple.product-type.tv-app-extension': 'tv_extension',
  'com.apple.product-type.xpc-service': 'xpc_service',
}

// A setting of a target, alike in each of its configurations: the target's own value, else the project's.
function common(objects, lists, key, where) {
  const [own, project] = lists.map((list) => objects[list].buildConfigurations.map((id) => objects[id]))
  const values = new Set(own.map((configuration) => configuration.buildSettings[key] ?? project.find((other) => other.name === configuration.name)?.buildSettings[key]))
  if (values.size > 1) throw new PodError(`its configurations have ${key} as ${[...values].map((value) => quote(String(value))).join(' and ')}, of which CocoaPods takes one`, where)
  return [...values][0]
}

// The Pods target's label, by Target#xcconfig_path: `<label>.<configuration, lower case, `/` as `-`>.xcconfig`.
// Either may have a period; where the file is of another configuration, as one copied in Xcode since, the last
// part before `.xcconfig` is taken for its name.
function labelOf(path, configuration) {
  const name = path === undefined ? '' : basename(path)
  const suffix = `.${configuration.replaceAll('/', '-').toLowerCase()}.xcconfig`
  if (name.startsWith('Pods-') && name.endsWith(suffix)) return name.slice(0, -suffix.length)
  return /^(Pods-.+)\.[^.]+\.xcconfig$/u.exec(name)?.[1]
}

// `text` is the project.pbxproj. A target's label is its Pods target's name, or undefined; its scripts are those
// its phases run, from Target Support Files; its dependencies are ids, of the targets it hosts where embedded.
export function readUserProject(text, where) {
  const { objects, rootObject, objectVersion } = parseAscii(text, where)
  const project = objects?.[rootObject]
  if (project?.isa !== 'PBXProject') throw new PodError('the project file has no project', where)
  const targets = project.targets.filter((uuid) => objects[uuid].isa === 'PBXNativeTarget').map((uuid) => {
    const target = objects[uuid]
    const at = `${where}: targets[${quote(target.name)}]`
    const own = objects[target.buildConfigurationList].buildConfigurations.map((id) => objects[id])
    const labels = new Set(own.map((configuration) => labelOf(objects[configuration.baseConfigurationReference]?.path, configuration.name)))
    if (labels.size > 1) throw new PodError('its configurations are based on the xcconfigs of more than one Pods target, or some on none', at)
    const lists = [target.buildConfigurationList, project.buildConfigurationList]
    const phases = (target.buildPhases ?? []).map((id) => objects[id]).filter((phase) => phase?.isa === 'PBXShellScriptBuildPhase')
    const dependencies = (target.dependencies ?? []).map((one) => objects[one]?.target ?? objects[objects[one]?.targetProxy]?.remoteGlobalIDString)
    return {
      id: uuid,
      name: target.name,
      label: [...labels][0],
      dependencies: dependencies.filter((one) => one !== undefined),
      scripts: phases.flatMap((phase) => [...String(phase.shellScript ?? '').matchAll(/Target Support Files\/([^/"\n]+\/[^/"\n]+\.sh)/gu)].map((match) => match[1])),
      configurations: own.map((configuration) => configuration.name),
      productType: PRODUCT_TYPES[target.productType] ?? target.productType,
      swiftVersion: common(objects, lists, 'SWIFT_VERSION', at),
      deploymentTarget: common(objects, lists, 'IPHONEOS_DEPLOYMENT_TARGET', at),
      extensionApiOnly: common(objects, lists, 'APPLICATION_EXTENSION_API_ONLY', at) === 'YES',
    }
  })
  return { targets, objectVersion }
}
