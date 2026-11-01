// A downloaded pod's directory as `pod install` leaves it in Pods/: cleaned
// once in CocoaPods' download cache, for every spec of the podspec on every
// platform each takes; copied into Pods/; cleaned again there, for the
// specs installed; and its source files made read-only.

import { DeptreeError, quote } from '../error.js'
import { clean, lock } from './clean.js'
import { PodTree } from './podtree.js'
import { allSpecs, consumerOf, licenseFileOf, platformsOf } from './podspec.js'

// What a spec's file patterns come to on each platform it takes, of
// `platforms` where they are given. The lockfile does not say which of
// them a pod was installed for, so a spec installed is held to name the
// same files on each.
function uniformConsumer(spec, platforms, where) {
  const taken = platformsOf(spec, where).filter((platform) => platforms?.includes(platform) ?? true)
  if (taken.length === 0) throw new DeptreeError(`${quote(spec.name)} is for none of the platforms given`, where)
  const [first, ...others] = taken.map((platform) => [platform, consumerOf(spec, platform, where)])
  const shown = JSON.stringify(first[1])
  const other = others.find(([, values]) => JSON.stringify(values) !== shown)
  if (other !== undefined) {
    const which = platforms === undefined ? 'and the platforms it is installed for are not given' : 'and the lockfile does not say which of the platforms given it is installed for'
    throw new DeptreeError(`${quote(spec.name)} names other files on ${other[0]} than on ${first[0]}, ${which}`, where)
  }
  return first[1]
}

// `contents` are the download's, as writeFiles takes them; `podspec` its
// root spec, `installed` the specs of it the lockfile has, and `platforms`
// those its targets are for, or undefined for any.
export function installPod(contents, podspec, installed, platforms, where) {
  const tree = new PodTree(contents, where)
  const license = licenseFileOf(podspec, where)
  // Downloader::Cache#copy_and_clean, its group_subspecs_by_platform.
  clean(tree, allSpecs(podspec).flatMap((spec) => platformsOf(spec, where).map((platform) => consumerOf(spec, platform, where))), license)
  // FileUtils.cp_r into Pods/, as a umask of 0o022 leaves each file.
  for (const node of tree.nodes.values()) if (node.type === 'file') node.mode &= ~0o022
  // PodSourceInstaller#clean!, then Installer#lock_pod_sources.
  const used = installed.map((spec) => uniformConsumer(spec, platforms, where))
  clean(tree, used, license)
  lock(tree, used)
  return tree.contents()
}
