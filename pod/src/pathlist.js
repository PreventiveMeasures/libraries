// A pod's directory as CocoaPods' PathList lists it and matches its file patterns, and Dir.glob, which a podspec
// read without Ruby may call. Paths are from the pod's directory.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { expandBraces, matcher } from '@preventive/deptree/src/cocoapods/fnmatch.js'

import { PodError, quote } from './error.js'
import { byBytes } from './order.js'

// Ruby's sort_by(&:upcase), each path's key computed once.
const byUpcase = (paths) => paths.map((path) => [path, Buffer.from(path.toUpperCase())]).sort(([, a], [, b]) => Buffer.compare(a, b)).map(([path]) => path)

// PathList#read_file_system: `**/*` with FNM_DOTMATCH. Links are not entered, but a link to a directory is
// listed as one; a directory whose path ends in `.` is skipped.
export function listPod(root, where) {
  const files = []
  const dirs = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      const full = join(dir, entry.name)
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(full, { throwIfNoEntry: false })?.isDirectory() === true)
      if (!isDir) files.push(path)
      else if (!path.endsWith('.')) dirs.push(path)
      if (entry.isDirectory()) walk(full, `${path}/`)
    }
  }
  try {
    walk(root, '')
  } catch (error) {
    throw new PodError(`its directory ${quote(root)} cannot be read`, where, { cause: error })
  }
  const list = { root, where, files: byUpcase(files), dirs: byUpcase(dirs), cache: new Map() }
  list.lowerDirs = new Set(list.dirs.map((dir) => dir.toLowerCase()))
  return list
}

// PathList#relative_glob: matches in the list's order, pattern by pattern.
export function glob(list, patterns, { dirPattern, exclude = [], includeDirs = false } = {}) {
  if (patterns.length === 0) return []
  const key = JSON.stringify([patterns, dirPattern, exclude, includeDirs])
  if (list.cache.has(key)) return list.cache.get(key)
  const all = includeDirs ? [...list.files, ...list.dirs] : list.files
  const exact = new Set(all)
  let found = patterns.flatMap((pattern) => {
    if (typeof pattern !== 'string') throw new PodError(`a file pattern that is no text, ${JSON.stringify(pattern)}`, list.where)
    if (exact.has(pattern)) return [pattern]
    const isDir = list.lowerDirs.has(pattern.toLowerCase().replace(/\/$/u, ''))
    const full = isDir && dirPattern !== undefined ? `${pattern.endsWith('/') ? pattern : `${pattern}/`}${dirPattern}` : pattern
    const expanded = expandBraces(full)
    if (expanded === undefined) throw new PodError(`the file pattern ${quote(pattern)} is too long, expands to too many, or has a backslash in braces`, list.where)
    const matchers = expanded.map(matcher)
    return all.filter((path) => matchers.some((matches) => matches(path)))
  })
  if (exclude.length > 0) {
    const excluded = new Set(glob(list, exclude, { dirPattern: '**/*', includeDirs }))
    found = found.filter((path) => !excluded.has(path))
  }
  list.cache.set(key, found)
  return found
}

// Dir.glob from `dir`, for a podspec that lists files itself: files and directories in byte order. Only what is
// under the pattern's part before its first wildcard is listed, and case is ignored, as on a Mac's volume.
export function dirGlob(dir, pattern, where) {
  const segments = pattern.split('/')
  const literal = segments.findIndex((segment) => /[*?[{\\]/u.test(segment))
  if (pattern.startsWith('/') || literal === -1) throw new PodError(`a glob of ${quote(pattern)}, which is from no directory of the podspec's, or has no wildcard`, where)
  const base = segments.slice(0, literal).join('/')
  const list = listPod(join(dir, base), where)
  const found = glob(list, [segments.slice(literal).join('/')], { includeDirs: true })
  return found.map((path) => (base === '' ? path : `${base}/${path}`)).sort(byBytes)
}
