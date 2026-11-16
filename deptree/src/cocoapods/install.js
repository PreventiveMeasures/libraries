// A downloaded pod's directory as `pod install` leaves it in Pods/: cleaned in the download cache for every
// spec on every platform, copied into Pods/, cleaned there for the specs installed, its sources made read-only

import { DeptreeError, quote } from '../error.js'
import { clean, lock } from './clean.js'
import { PodTree } from './podtree.js'
import { allSpecs, consumerOf, licenseFileOf, platformsOf } from './podspec.js'

// A spec's file patterns on each platform it takes, of `platforms` where given, which have to name the
// same files, as the lockfile does not say which a pod was installed for
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

// What a podspec says of the files CocoaPods keeps, checked whole before anything is downloaded: the
// license file, and the consumerOf values of every spec on every platform, for the clean in the cache, and
// of the `installed` specs, for the clean in Pods/
export function planPod(podspec, installed, platforms, where) {
  return {
    license: licenseFileOf(podspec, where),
    every: allSpecs(podspec).flatMap((spec) => platformsOf(spec, where).map((platform) => consumerOf(spec, platform, where))),
    used: installed.map((spec) => uniformConsumer(spec, platforms, where)),
  }
}

// The download as `plan` leaves it. `keepsGit` where 1.13 to 1.15 copy a clone's .git into the cache,
// which is refused where the clean there keeps it, as what is in it is not known.
export function installPod(contents, plan, { folded, keepsGit, where }) {
  const tree = new PodTree(keepsGit ? { ...contents, dirs: [...contents.dirs, '.git'] } : contents, folded, where)
  const budget = { matches: 0 }
  // Downloader::Cache#copy_and_clean; its copy into Pods/, FileUtils.cp_r under a 0o022 umask, keeps the
  // download's modes
  clean(tree, plan.every, plan.license, budget)
  if (tree.nodes.has('.git')) throw new DeptreeError('its file patterns keep the .git of the clone, which CocoaPods before 1.16 copies into its cache, and which is not built', where)
  // PodSourceInstaller#clean!, then Installer#lock_pod_sources.
  clean(tree, plan.used, plan.license, budget)
  lock(tree, plan.used, budget)
  return tree.contents()
}
