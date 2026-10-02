// What pnpm reads of the project (../project.js), and only that: the files
// pnpm reads at the root for an install, the package.json of each project
// and the patches the settings name, where buildPnpmTree is not handed
// them; the directories findProjects walks; and those a `link:` or `file:`
// leads to (local.js).

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readText, typeOf } from '../project.js'

// pnpm-workspace.yaml, where it is. pnpm looks for it under other names
// too, and refuses one it finds so.
const MISNAMED = ['pnpm-workspaces.yaml', 'pnpm-workspaces.yml', 'pnpm-workspace.yml', '.pnpm-workspace.yaml', '.pnpm-workspace.yml', '.pnpm-workspaces.yaml', '.pnpm-workspaces.yml']
export function readWorkspaceText(project) {
  const text = readText(project, '/pnpm-workspace.yaml')
  const misnamed = text === undefined ? MISNAMED.find((name) => typeOf(project, `/${name}`) === 'file') : undefined
  if (misnamed !== undefined) throw new DeptreeError('pnpm refuses a workspace manifest not named pnpm-workspace.yaml', quote(misnamed))
  return text
}

// What pnpm reads at the root for an install besides the package.json:
// pnpm-lock.yaml, which a frozen install cannot do without, and
// pnpm-workspace.yaml and the .npmrc, where they are.
export function readRootFiles(project) {
  const lockfile = readText(project, '/pnpm-lock.yaml')
  if (lockfile === undefined) throw new DeptreeError('the project has no pnpm-lock.yaml, which a frozen install cannot do without')
  return { lockfile, workspace: readWorkspaceText(project), npmrc: readText(project, '/.npmrc') }
}

// The text of the package.json of each of `ids`, the projects'
// directories, by directory.
export function readManifestTexts(project, ids) {
  const texts = new Map()
  for (const id of ids) {
    texts.set(id, readText(project, id === '.' ? '/package.json' : `/${id}/package.json`, `manifests[${quote(id)}]`))
  }
  return texts
}

// The text of each patch `configured`, patchedDependencies, names, by its
// path from the lockfile's directory; one that is not there left out.
// One outside that directory, or absolute, is not in the project, and is
// refused.
export function readPatches(project, configured) {
  const texts = new Map()
  for (const [selector, spec] of Object.entries(configured ?? {})) {
    const path = normalize(spec)
    if (path === '..' || path.startsWith('../') || path.startsWith('/')) throw new DeptreeError(`the patch ${quote(spec)} is not in the project: it is outside the lockfile's directory`, `patchedDependencies[${quote(selector)}]`)
    const text = readText(project, `/${path}`, `patches[${quote(path)}]`)
    if (text !== undefined) texts.set(path, text)
  }
  return texts
}
