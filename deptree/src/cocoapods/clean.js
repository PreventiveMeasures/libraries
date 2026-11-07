// What CocoaPods keeps of a pod it downloads, held in memory: its
// PodDirCleaner removes every file and directory of the download that no
// spec uses, by the file patterns of each spec on each platform, through a
// PathList of what is there and a FileAccessor per spec and platform; its
// lock_files! then takes the owner's write off each source file. Each is
// followed as CocoaPods 1.13 to 1.17 have it, in Ruby 2.6 to 3.4.

import { DeptreeError, quote } from '../error.js'
import { expandBraces, matcher } from './fnmatch.js'

// FileAccessor::GLOB_PATTERNS, and what a source file is: Xcodeproj's
// header extensions after CocoaPods' own.
const HEADERS = ['.h', '.hh', '.hpp', '.ipp', '.tpp', '.hxx', '.def', '.inl', '.inc']
const SOURCES = [...new Set(['.m', '.mm', '.i', '.c', '.cc', '.cxx', '.cpp', '.c++', '.swift', ...HEADERS])]
const SOURCE_FILES = `*{${SOURCES.join(',')}}`
const README = 'readme{*,.*}'
const LICENSE = 'licen{c,s}e{*,.*}'
// What PathList#relative_glob lays under a directory an exclusion names.
const EXCLUDED_DIR = '**/*'
// The paths matched against a pattern, each of a pattern's expansions
// counted, past which a pod is refused rather than cleaned.
export const MAX_MATCHES = 200_000_000

// Ruby's String#downcase and #upcase: Unicode's mappings, without the
// final sigma, which takes the letters around it into account and Ruby
// does not.
const downcase = (text) => text.replaceAll('\u03A3', '\u03C3').toLowerCase()
const encoder = new TextEncoder()
function compareBytes(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
// Ruby's sort_by(&:upcase), which compares bytes.
const byUpcase = (paths) => paths.map((path) => [path, encoder.encode(path.toUpperCase())]).sort(([, a], [, b]) => compareBytes(a, b)).map(([path]) => path)

// Sandbox::PathList: what `**/*` with FNM_DOTMATCH finds in the pod's
// directory, entering no link, each a directory where File.directory? says
// so and a file where it does not, a directory whose path ends in `.`
// passed over; each list sorted by sort_by(&:upcase).
class PathList {
  constructor(tree, budget) {
    this.tree = tree
    this.budget = budget
    const dirs = []
    const files = []
    for (const path of tree.paths) {
      if (!tree.isDirectory(path)) files.push(path)
      else if (!path.endsWith('.')) dirs.push(path)
    }
    this.files = byUpcase(files)
    this.dirs = byUpcase(dirs)
    this.lowerDirs = new Set(this.dirs.map(downcase))
    this.cache = new Map()
  }

  // PathList#directory?, by downcase.
  isDirectory(pattern) {
    return this.lowerDirs.has(downcase(pattern).replace(/\/$/u, ''))
  }

  // PathList#relative_glob: each pattern a path of the list as it is, or
  // else, where it names a directory and `dirPattern` is given, that laid
  // under it; then its braces expanded, and every path of the list that
  // one of them matches. Those `exclude` matches, under a directory it
  // names too, are taken out. Paths come back in the order of the list,
  // pattern by pattern, the same path more than once where two match it.
  glob(patterns, { dirPattern, exclude = [], includeDirs = false } = {}) {
    if (patterns.length === 0) return []
    const key = JSON.stringify([patterns, dirPattern, exclude, includeDirs])
    if (this.cache.has(key)) return this.cache.get(key)
    const list = includeDirs ? [...this.files, ...this.dirs] : this.files
    const exact = new Set(list)
    let found = patterns.flatMap((pattern) => {
      if (exact.has(pattern)) return [pattern]
      const full = this.isDirectory(pattern) && dirPattern !== undefined ? `${pattern.endsWith('/') ? pattern : `${pattern}/`}${dirPattern}` : pattern
      const expanded = expandBraces(full)
      if (expanded === undefined) throw new DeptreeError(`the file pattern ${quote(pattern)} is too long, expands to too many, or has a backslash in braces`, this.tree.where)
      this.budget.matches += expanded.length * list.length
      if (this.budget.matches > MAX_MATCHES) throw new DeptreeError(`its file patterns take more than ${MAX_MATCHES} matches of a path to clean it, which is not followed`, this.tree.where)
      const matchers = expanded.map(matcher)
      return list.filter((path) => matchers.some((matches) => matches(path)))
    })
    if (exclude.length > 0) {
      const excluded = new Set(this.glob(exclude, { dirPattern: EXCLUDED_DIR, includeDirs }))
      found = found.filter((path) => !excluded.has(path))
    }
    this.cache.set(key, found)
    return found
  }

  // `glob([pattern]).first`, as readme and license take it: refused where
  // two that sort_by(&:upcase) leaves in no set order could be first.
  first(pattern) {
    const [one, two] = this.glob([pattern])
    if (two !== undefined && one.toUpperCase() === two.toUpperCase()) throw new DeptreeError(`${quote(one)} and ${quote(two)} differ in case alone, and CocoaPods takes either as the first ${pattern}`, this.tree.where)
    return one
  }
}

// FileAccessor#source_files, of one spec on one platform: `values` are its
// consumerOf.
const sourceFiles = (list, values) => list.glob(values.source_files, { dirPattern: SOURCE_FILES, exclude: values.exclude_files })

// FileAccessor.all_files, of one spec on one platform: the paths of what it
// uses, from the pod's directory, as each accessor finds them; the prefix
// header's, the module map's and the license's as the podspec gives them.
function usedFiles(list, values, licenseFile) {
  const exclude = values.exclude_files
  const withDirs = (patterns) => list.glob(patterns, { exclude, includeDirs: true })
  const license = licenseFile !== undefined && list.tree.exists(licenseFile) ? licenseFile : list.first(LICENSE)
  return [
    ...withDirs(values.vendored_frameworks),
    ...list.glob(values.vendored_libraries, { exclude }),
    ...withDirs(values.resource_bundles),
    license,
    values.prefix_header_file,
    ...withDirs(values.preserve_paths),
    list.first(README),
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

// Whether one of `sorted` starts with `text`, or `text` with one of them.
// One `text` starts with is at or before it, and so is all that comes
// between the two: the last before it starts with that one too, so that
// where it is not one, the search goes on in what the two have in common.
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

// PodDirCleaner#clean!, by the consumerOf values of each spec on each
// platform it is cleaned for: every path of the pod's directory removed,
// all under it with it, but what ends in `.`, and what is a used file's
// path or one of whose paths is in the other, downcased, as `include?`
// finds one string in another. The pod's directory has its own path in
// front of each, and is taken not to come again within one, so that one
// is in the other where it is at its start. `budget` counts the matches
// made, across every clean of the pod.
export function clean(tree, accessors, licenseFile, budget) {
  const list = new PathList(tree, budget)
  const used = [...new Set(uniqueOf(accessors).flatMap((values) => usedFiles(list, values, licenseFile)).map(downcase))].sort()
  const kept = (path) => path.endsWith('.') || sharesStart(used, downcase(path))
  tree.removeAll(new Set(tree.paths.filter((one) => !kept(one))))
}

// lock_files!: the owner's write taken off each source file, by the file
// that a link among them leads to, as chmod follows it. A link that leads
// to nothing CocoaPods fails on, as File.stat does.
export function lock(tree, accessors, budget) {
  const list = new PathList(tree, budget)
  for (const path of new Set(uniqueOf(accessors).flatMap((values) => sourceFiles(list, values)))) {
    const resolved = tree.resolve(path)
    if (resolved === undefined) throw new DeptreeError(`the source file ${quote(path)} links to nothing, and CocoaPods fails on it as it makes it read-only`, tree.where)
    if (resolved.node.type === 'file') resolved.node.mode &= ~0o200
  }
}
