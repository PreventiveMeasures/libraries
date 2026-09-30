// Directories outside node_modules the tree links to or installs, read
// from the project (project.js) where one is given: those local overrides
// name, and every other a `link:` leads to that is no project and is under
// the lockfile's directory. Each has to hold a package.json there, whose
// bins take their names as pnpm links them. An override to a directory is
// read only from a project given. One by `file:` has pnpm install the
// directory as a package, of the files npm-packlist picks (packlist.js);
// one to a tarball is refused.

import { DeptreeError, quote } from '../error.js'
import { packDirectory } from './packlist.js'
import { readText, typeOf } from './project.js'
import { readManifest } from './projects.js'

function manifestAt(project, dir, where) {
  const text = readText(project, `/${dir}/package.json`, where)
  if (text === undefined) throw new DeptreeError(`${quote(dir)} holds no package.json in the project given`, where)
  return readManifest(text, where)
}

// `overrides` is listOverrides's. It gives back the directories `file:`
// overrides have pnpm install.
export function checkLocalOverrides(overrides, project) {
  const installed = new Set()
  for (const { selector, local } of overrides) {
    if (local === undefined) continue
    const where = `overrides[${quote(selector)}]`
    if (project === undefined) throw new DeptreeError(`an override to a directory, ${quote(local.dir)}, is read only from a project given`, where)
    if (local.protocol === 'file:' && typeOf(project, `/${local.dir}`) === 'file') throw new DeptreeError(`${quote(local.dir)} is a file in the project given, and an override to a tarball is not supported`, where)
    manifestAt(project, local.dir, where)
    if (local.protocol === 'file:') installed.add(local.dir)
  }
  return installed
}

// The package at the directory a `file:` dependency names, from `project`:
// its files as npm-packlist picks them, and its package.json, which has
// to be for the name the lockfile has; the lockfile has no version.
export function readDirectoryPackage(project, pkg, where, major) {
  const { directory } = pkg.resolution
  const manifest = manifestAt(project, directory, where)
  if (manifest.name !== pkg.name) throw new DeptreeError(`its package.json is for ${quote(String(manifest.name))}`, where)
  return { files: packDirectory(project, directory, manifest, major, where), manifest }
}

// By directory, the package.json of each directory the tree links to that
// is no node of `nodes`, no project of `projects`, and under the
// lockfile's directory, read from `project`; none without one.
export function readLinked(links, nodes, projects, project) {
  const linked = new Map()
  if (project === undefined) return linked
  for (const [path, target] of links) {
    if (nodes.has(target) || projects.has(target) || linked.has(target) || target === '..' || target.startsWith('../')) continue
    linked.set(target, manifestAt(project, target, quote(path)))
  }
  return linked
}
