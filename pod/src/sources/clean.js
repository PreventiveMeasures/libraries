// What CocoaPods keeps of a pod it downloads: cleaned once in its download cache, for every spec on every platform
// each takes; again in Pods/, for the specs installed; then its source files made read-only. As CocoaPods 1.13 to
// 1.17 have it, in Ruby 2.6 to 3.4.

import { PodError, quote } from '../error.js'
import { SOURCES, downcase, glob, pathList } from '../pathlist.js'
import { PodTree } from './podtree.js'
import { allSpecs, consumerOf, licenseFileOf, platformsOf } from './podspec.js'

const SOURCE_FILES = `*{${SOURCES.join(',')}}`
const README = 'readme{*,.*}'
const LICENSE = 'licen{c,s}e{*,.*}'

// Sandbox::PathList of the download: a path is a directory where File.directory?, which follows links, says so.
function listOf(tree, budget) {
  const files = []
  const dirs = []
  for (const path of tree.paths) {
    if (!tree.isDirectory(path)) files.push(path)
    else if (!path.endsWith('.')) dirs.push(path)
  }
  return pathList(files, dirs, tree.where, budget)
}

// `glob([pattern]).first`, as readme and license take it: refused where two that sort_by(&:upcase) leaves in no
// set order could be first.
function firstOf(list, pattern) {
  const [one, two] = glob(list, [pattern])
  if (two !== undefined && one.toUpperCase() === two.toUpperCase()) throw new PodError(`${quote(one)} and ${quote(two)} differ in case alone, and CocoaPods takes either as the first ${pattern}`, list.where)
  return one
}

const sourceFiles = (list, values) => glob(list, values.source_files, { dirPattern: SOURCE_FILES, exclude: values.exclude_files })

// FileAccessor.all_files of one spec on one platform, `values` its consumerOf: the paths of what it uses.
function usedFiles(tree, list, values, licenseFile) {
  const exclude = values.exclude_files
  const withDirs = (patterns) => glob(list, patterns, { exclude, includeDirs: true })
  const license = licenseFile !== undefined && tree.exists(licenseFile) ? licenseFile : firstOf(list, LICENSE)
  return [
    ...withDirs(values.vendored_frameworks),
    ...glob(list, values.vendored_libraries, { exclude }),
    ...withDirs(values.resource_bundles),
    license,
    values.prefix_header_file,
    ...withDirs(values.preserve_paths),
    firstOf(list, README),
    ...withDirs(values.resources),
    ...withDirs(values.on_demand_resources),
    ...sourceFiles(list, values),
    values.module_map,
  ].filter((path) => path !== undefined)
}

// The index of the first of `sorted` at or after `text`.
function firstFrom(sorted, text) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] < text) low = mid + 1
    else high = mid
  }
  return low
}

// Whether one of `sorted` starts with `text`, or `text` with one of them. One that `text` starts with sorts at or
// before it, and so does all between the two, so the search goes on in what each shares with `text`.
function sharesStart(sorted, text) {
  let at = firstFrom(sorted, text)
  if (sorted[at]?.startsWith(text)) return true
  for (let start = text; at > 0;) {
    const before = sorted[at - 1]
    if (start.startsWith(before)) return true
    let common = 0
    while (common < before.length && before[common] === start[common]) common++
    if (common === 0) return false
    start = start.slice(0, common)
    at = firstFrom(sorted, start)
    if (sorted[at] === start) return true
  }
  return false
}

// Each set of values once, as specs and platforms often share one.
const uniqueOf = (accessors) => [...new Map(accessors.map((one) => [JSON.stringify(one), one])).values()]

// PodDirCleaner#clean!: every path removed, with all under it, but what ends in `.`, and what a used file's path
// is in, or is in it, downcased, as `include?` finds one string in another.
function clean(tree, accessors, licenseFile, budget) {
  const list = listOf(tree, budget)
  const used = [...new Set(uniqueOf(accessors).flatMap((values) => usedFiles(tree, list, values, licenseFile)).map(downcase))].sort()
  const kept = (path) => path.endsWith('.') || sharesStart(used, downcase(path))
  tree.removeAll(new Set(tree.paths.filter((one) => !kept(one))))
}

// lock_files!: the owner's write taken off each source file, by the file a link leads to, as chmod follows it.
function lock(tree, accessors, budget) {
  const list = listOf(tree, budget)
  for (const path of new Set(uniqueOf(accessors).flatMap((values) => sourceFiles(list, values)))) {
    const resolved = tree.resolve(path)
    if (resolved === undefined) throw new PodError(`the source file ${quote(path)} links to nothing, and CocoaPods fails on it as it makes it read-only`, tree.where)
    if (resolved.node.type === 'file') resolved.node.mode &= ~0o200
  }
}

// A spec's patterns on each platform it takes, of `platforms` where given. The lockfile does not say which a pod
// was installed for, so a spec installed has to name the same files on each.
function uniformConsumer(spec, platforms, where) {
  const taken = platformsOf(spec, where).filter((platform) => platforms?.includes(platform) ?? true)
  if (taken.length === 0) throw new PodError(`${quote(spec.name)} is for none of the platforms given`, where)
  const [first, ...others] = taken.map((platform) => [platform, consumerOf(spec, platform, where)])
  const shown = JSON.stringify(first[1])
  const other = others.find(([, values]) => JSON.stringify(values) !== shown)
  if (other !== undefined) {
    const which = platforms === undefined ? 'and the platforms it is installed for are not given' : 'and the lockfile does not say which of the platforms given it is installed for'
    throw new PodError(`${quote(spec.name)} names other files on ${other[0]} than on ${first[0]}, ${which}`, where)
  }
  return first[1]
}

// What a podspec says of the files CocoaPods keeps, checked whole before anything is downloaded: its license
// file, and the patterns of every spec on every platform, and of the specs `installed` on `platforms`.
export function planPod(podspec, installed, platforms, where) {
  return {
    license: licenseFileOf(podspec, where),
    every: allSpecs(podspec).flatMap((spec) => platformsOf(spec, where).map((platform) => consumerOf(spec, platform, where))),
    used: installed.map((spec) => uniformConsumer(spec, platforms, where)),
  }
}

// The download as `plan` leaves it. `folded` on macOS; `keepsGit` where it is a clone whose .git CocoaPods before
// 1.16 copies into its cache, refused where the clean there keeps it, as what is in it is not known.
export function installPod(contents, plan, { folded, keepsGit, where }) {
  const tree = new PodTree(keepsGit ? { ...contents, dirs: [...contents.dirs, '.git'] } : contents, folded, where)
  const budget = { matches: 0 }
  // Downloader::Cache#copy_and_clean, whose copy into Pods/ keeps the download's modes.
  clean(tree, plan.every, plan.license, budget)
  if (tree.nodes.has('.git')) throw new PodError('its file patterns keep the .git of the clone, which CocoaPods before 1.16 copies into its cache, and which is not built', where)
  // PodSourceInstaller#clean!, then Installer#lock_pod_sources.
  clean(tree, plan.used, plan.license, budget)
  lock(tree, plan.used, budget)
  return tree.contents()
}
