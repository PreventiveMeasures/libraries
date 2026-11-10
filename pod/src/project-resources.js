// What CocoaPods makes of a pod's localized files and its other resources in the Pods project: which of its
// paths get a reference at all, the variant group that holds a file of an .lproj directory, the regions the
// project knows of, and the references a target's phases take for a list of resources.

import { join, posix } from 'node:path'

import { newFile, newGroup } from './project.js'

export const isLproj = (name) => name.toLowerCase().includes('.lproj')

const dirsOf = (list) => list.dirSet ??= new Set(list.dirs)

// merge_to_docc_folder: a documentation catalog is one reference, of its directory, for the files in it.
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

// FileReferencesInstaller#allowable_project_paths: the paths that get a reference. Not what is inside a data
// model, a mapping model or an asset catalog, whose directory has one; and an .lproj directory only where no
// file of it has one, after all the others.
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

// Project#variant_group_name: a localized file's own name; and of the .strings beside an interface file of
// Base.lproj, that file's. CocoaPods asks the disk, which on a Mac tells no case apart unless made to.
function variantName(list, path) {
  const extension = posix.extname(path)
  if (extension.toLowerCase() !== '.strings') return posix.basename(path)
  const files = list.lowerFiles ??= new Set(list.files.map((file) => file.toLowerCase()))
  const stem = posix.basename(path, extension)
  const base = posix.join(posix.dirname(posix.dirname(path)), 'Base.lproj')
  const found = ['.xib', '.storyboard'].find((one) => files.has(posix.join(base, `${stem}${one}`).toLowerCase()))
  return found === undefined ? posix.basename(path) : `${stem}${found}`
}

// Project#group_for_path_in_group and #add_file_reference, of a file whose directory is an .lproj: its
// reference is in a variant group, one in the whole project for the directory the .lproj is in and the name.
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

// FileReferencesInstaller#add_known_regions: the regions of the references' .lproj directories, with those the
// project has, in the order of their bytes.
export function addKnownRegions(project, refs) {
  const regions = refs.map((ref) => /(?:\/|^)(?<region>[^/]*?)\.lproj(?:\/|$)/u.exec(ref.path)?.groups.region).filter((region) => region !== undefined)
  project.root.knownRegions = [...new Set([...project.root.knownRegions, ...regions])].sort()
}

// PodTargetInstaller#filter_resource_file_references: the references of `paths`, each once, a variant group
// for what is in one, and none for a path that has none; those that are compiled apart from the others.
export function resourceRefs(project, target, paths) {
  const found = paths.map((path) => project.refs.get(join(target.dir, path))).filter((ref) => ref !== undefined)
  const refs = [...new Set(found.map((ref) => ref._variant ?? ref))]
  const isCompiled = (ref) => /\.(?:xcdatamodeld|rcproject)/iu.test(ref.path)
  return { compiled: refs.filter(isCompiled), copied: refs.filter((ref) => !isCompiled(ref)) }
}
