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

// What a pod's podspec says of the files CocoaPods keeps of it, read and
// checked whole before anything is downloaded: the license file it names,
// the consumerOf values of every spec on every platform each takes, for
// the clean in the download cache, and of the specs installed, for the
// clean in Pods/. `installed` are the specs of `podspec` the lockfile has,
// and `platforms` those the Podfile's targets are for, or undefined for
// any.
export function planPod(podspec, installed, platforms, where) {
  return {
    license: licenseFileOf(podspec, where),
    every: allSpecs(podspec).flatMap((spec) => platformsOf(spec, where).map((platform) => consumerOf(spec, platform, where))),
    used: installed.map((spec) => uniformConsumer(spec, platforms, where)),
  }
}

// The download, `contents` as writeFiles takes them, as planPod's `plan`
// leaves it. `folded` where the pod is on macOS; `keepsGit` where the
// download is a clone, whose .git CocoaPods copies into its cache with the
// rest, as 1.13 to 1.15 do, which is refused where the clean there keeps
// it, as what is in it is not known; an archive has none.
export function installPod(contents, plan, { folded, keepsGit, where }) {
  const tree = new PodTree(keepsGit ? { ...contents, dirs: [...contents.dirs, '.git'] } : contents, folded, where)
  const budget = { matches: 0 }
  // Downloader::Cache#copy_and_clean, its group_subspecs_by_platform. Its
  // copy into Pods/, FileUtils.cp_r under a umask of 0o022, keeps the modes
  // a download has, a checkout's 0o644 and 0o755 or an archive's under that
  // umask as tar extracts it.
  clean(tree, plan.every, plan.license, budget)
  if (tree.nodes.has('.git')) throw new DeptreeError('its file patterns keep the .git of the clone, which CocoaPods before 1.16 copies into its cache, and which is not built', where)
  // PodSourceInstaller#clean!, then Installer#lock_pod_sources.
  clean(tree, plan.used, plan.license, budget)
  lock(tree, plan.used, budget)
  return tree.contents()
}
