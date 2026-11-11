// A pod's resources in the Pods project: which paths get a reference, the variant groups of .lproj files, the
// project's known regions, and the references a target's phases take.

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { PodError, quote } from './error.js'
import { parseXml } from './plist.js'
import { newFile, newGroup, pathFrom } from './project.js'
import { byBytes } from './xcconfig.js'

export const isLproj = (name) => name.toLowerCase().includes('.lproj')

const dirsOf = (list) => list.dirSet ??= new Set(list.dirs)

// merge_to_docc_folder: a documentation catalog is one reference, of its directory.
export function mergeDocc(list, paths) {
  const dirs = dirsOf(list)
  const catalogs = new Set()
  const rest = paths.filter((path) => {
    if (!/\.docc(?:\/|$)/iu.test(path)) return true
    if (!dirs.has(path)) catalogs.add(`${path.split('.docc')[0]}.docc`)
    return false
  })
  return [...rest, ...catalogs]
}

// FileReferencesInstaller#allowable_project_paths: not what is in a data model, a mapping model or an asset
// catalog, whose directory has the reference; an .lproj directory only where none of its files has one, last.
export function allowablePaths(list, paths) {
  const dirs = dirsOf(list)
  const empty = new Set()
  const filled = new Set()
  const allowed = mergeDocc(list, paths).filter((path) => {
    if (/\.(?:xcdatamodeld|xcmappingmodel|xcassets)\/.+/iu.test(path)) return false
    if (!/\.lproj(?:\/|$)/iu.test(path)) return true
    if (/\.lproj$/iu.test(path) && dirs.has(path)) {
      empty.add(path)
      return false
    }
    const inside = /(^.*\.lproj)\/.*/iu.exec(path)
    if (inside !== null) filled.add(inside[1])
    return true
  })
  return [...allowed, ...[...empty].filter((path) => !filled.has(path))]
}

// Project#variant_group_name: a localized file's own name, or of a .strings beside an interface file of
// Base.lproj, that file's. Case is ignored, as by a Mac's disk.
function variantName(list, path) {
  const extension = posix.extname(path)
  if (extension.toLowerCase() !== '.strings') return posix.basename(path)
  const files = list.lowerFiles ??= new Set(list.files.map((file) => file.toLowerCase()))
  const stem = posix.basename(path, extension)
  const base = posix.join(posix.dirname(posix.dirname(path)), 'Base.lproj')
  const found = ['.xib', '.storyboard'].find((one) => files.has(posix.join(base, `${stem}${one}`).toLowerCase()))
  return found === undefined ? posix.basename(path) : `${stem}${found}`
}

// Project#group_for_path_in_group and #add_file_reference of a file in an .lproj: its reference is in the
// project's one variant group of the .lproj's directory and the name.
export function addLocalized(project, group, target, path) {
  const name = variantName(target.list, path)
  const dir = join(target.dir, posix.dirname(posix.dirname(path)))
  const key = `${dir}\n${name}`
  project.variants ??= new Map()
  if (!project.variants.has(key)) project.variants.set(key, newGroup(group, name, dir, 'PBXVariantGroup'))
  const ref = newFile(project, project.variants.get(key), join(target.dir, path))
  ref._variant ??= project.variants.get(key)
  return ref
}

// FileReferencesFactory#new_xcdatamodeld: a version group of the model's versions, the current one as its
// .xccurrentversion names it. They are in the order of their names, where Xcodeproj has the disk's.
export function addDataModel(project, group, target, path) {
  const real = join(target.dir, path)
  if (project.refs.has(real)) return project.refs.get(real)
  const { files, dirs } = target.list
  const from = pathFrom(group._real, real)
  const versions = [...files, ...dirs].filter((one) => posix.dirname(one) === path && posix.extname(one) === '.xcdatamodel').sort(byBytes)
  const children = versions.map((one) => ({ isa: 'PBXFileReference', includeInIndex: '1', lastKnownFileType: 'wrapper.xcdatamodel', path: posix.basename(one), sourceTree: '<group>', _real: join(target.dir, one) }))
  const ref = { isa: 'XCVersionGroup', children, ...(from.includes('/') ? { name: posix.basename(path) } : {}), path: from, sourceTree: '<group>', versionGroupType: 'wrapper.xcdatamodel', _real: real }
  if (files.includes(posix.join(path, '.xccurrentversion'))) {
    let name
    try {
      name = parseXml(readFileSync(join(real, '.xccurrentversion'), 'utf8'), target.where)?._XCCurrentVersionName
    } catch (error) {
      throw new PodError(`the .xccurrentversion of ${quote(path)} cannot be read as an XML property list`, target.where, { cause: error })
    }
    const current = children.find((child) => child.path === name)
    if (current !== undefined) ref.currentVersion = current
  }
  group.children.push(ref)
  project.refs.set(real, ref)
  return ref
}

// FileReferencesInstaller#add_known_regions: the project's regions and those of the references' .lproj
// directories, sorted.
export function addKnownRegions(project, refs) {
  const regions = refs.map((ref) => /(?:\/|^)(?<region>[^/]*?)\.lproj(?:\/|$)/u.exec(ref.path)?.groups.region).filter((region) => region !== undefined)
  project.root.knownRegions = [...new Set([...project.root.knownRegions, ...regions])].sort()
}

// PodTargetInstaller#filter_resource_file_references: the references of `paths` once each, a variant group for
// what is in one, the compiled apart from the copied.
export function resourceRefs(project, target, paths) {
  const found = paths.map((path) => project.refs.get(join(target.dir, path))).filter((ref) => ref !== undefined)
  const refs = [...new Set(found.map((ref) => ref._variant ?? ref))]
  const isCompiled = (ref) => /\.(?:xcdatamodeld|rcproject)/iu.test(ref.path)
  return { compiled: refs.filter(isCompiled), copied: refs.filter((ref) => !isCompiled(ref)) }
}
