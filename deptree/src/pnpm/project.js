// The project a tree is built for: a view of the lockfile's directory, by
// paths from `/` — a Vfs, or anything with its readdir, lstat, stat and
// readFile, such as one of a directory on disk. It is only read, and only
// where these say: the files pnpm reads at the root for an install, the
// package.json of each project and the patches the settings name, where
// buildPnpmTree is not handed them; the directories findProjects walks;
// and those a `link:` or `file:` leads to (local.js).

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

export function checkProject(project) {
  if (['readdir', 'lstat', 'stat', 'readFile'].some((name) => typeof project?.[name] !== 'function')) {
    throw new TypeError('project must be a Vfs, or have its readdir, lstat, stat and readFile')
  }
}

// What `path` leads to, links followed; nothing, where it leads nowhere:
// to no entry, through a file, or round a loop of links. Any other
// failure is thrown.
const NOWHERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
export function typeOf(project, path) {
  try {
    return project.stat(path).type
  } catch (error) {
    if (NOWHERE.has(error?.code)) return undefined
    throw error
  }
}

// As text handed in would be: a byte order mark kept, for what reads it
// to drop as pnpm does.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The bytes of the file at `path`, as a Vfs gives them back.
export function readBytes(project, path) {
  const bytes = project.readFile(path)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('project.readFile must give back bytes')
  return bytes
}

// The text of the file at `path`, or undefined where nothing is.
export function readText(project, path, where) {
  const type = typeOf(project, path)
  if (type === undefined) return undefined
  if (type !== 'file') throw new DeptreeError(`${quote(path.slice(1))} is a ${type}, not a file`, where)
  const bytes = readBytes(project, path)
  try {
    return decoder.decode(bytes)
  } catch {
    throw new DeptreeError(`${quote(path.slice(1))} is not UTF-8`, where)
  }
}

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
// One outside that directory is not in the project, and is refused.
export function readPatches(project, configured) {
  const texts = new Map()
  for (const [selector, spec] of Object.entries(configured ?? {})) {
    const path = normalize(spec)
    if (path === '..' || path.startsWith('../')) throw new DeptreeError(`the patch ${quote(spec)} is not in the project: it is outside the lockfile's directory`, `patchedDependencies[${quote(selector)}]`)
    const text = readText(project, `/${path}`, `patches[${quote(path)}]`)
    if (text !== undefined) texts.set(path, text)
  }
  return texts
}
