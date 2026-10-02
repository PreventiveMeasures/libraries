// What buildPnpmTree and findPnpmProjects take, checked: the host, and the
// files an install reads, given as text or read from the project as pnpm
// reads them from disk.

import { LockfileError, YamlError, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { checkProject, readText, typeOf } from '../project.js'
import { pinnedPnpm, readManifests } from './projects.js'
import { readers } from './readers.js'
import { checkWorkspace, findProjects, linkedManifest } from './workspace.js'

const LIBC = new Set(['glibc', 'musl', 'unknown'])

// pnpm also finds pnpm-workspace.yaml under these names, and refuses it.
const MISNAMED = ['pnpm-workspaces.yaml', 'pnpm-workspaces.yml', 'pnpm-workspace.yml', '.pnpm-workspace.yaml', '.pnpm-workspace.yml', '.pnpm-workspaces.yaml', '.pnpm-workspaces.yml']
function readWorkspaceText(project) {
  const text = readText(project, '/pnpm-workspace.yaml')
  const misnamed = text === undefined ? MISNAMED.find((name) => typeOf(project, `/${name}`) === 'file') : undefined
  if (misnamed !== undefined) throw new DeptreeError('pnpm refuses a workspace manifest not named pnpm-workspace.yaml', quote(misnamed))
  return text
}

function readRootFiles(project) {
  const lockfile = readText(project, '/pnpm-lock.yaml')
  if (lockfile === undefined) throw new DeptreeError('the project has no pnpm-lock.yaml, which a frozen install cannot do without')
  return { lockfile, workspace: readWorkspaceText(project), npmrc: readText(project, '/.npmrc') }
}

// `ids` are the projects' directories.
function readManifestTexts(project, ids) {
  const texts = new Map()
  for (const id of ids) {
    texts.set(id, readText(project, id === '.' ? '/package.json' : `/${id}/package.json`, `manifests[${quote(id)}]`))
  }
  return texts
}

// Each patch patchedDependencies (`configured`) names, by its path from
// the lockfile's directory; one that is not there is left out.
function readPatches(project, configured) {
  const texts = new Map()
  for (const [selector, spec] of Object.entries(configured ?? {})) {
    const path = normalize(spec)
    if (path === '..' || path.startsWith('../') || path.startsWith('/')) throw new DeptreeError(`the patch ${quote(spec)} is not in the project: it is outside the lockfile's directory`, `patchedDependencies[${quote(selector)}]`)
    const text = readText(project, `/${path}`, `patches[${quote(path)}]`)
    if (text !== undefined) texts.set(path, text)
  }
  return texts
}

// pnpm 12 before 12.8.1 installs otherwise in places, and is refused.
function majorOf(pnpm) {
  const major = Number(valid(pnpm)?.split('.')[0])
  if (major !== 10 && major !== 11 && major !== 12) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: only pnpm 10, 11 and 12 are`, 'host.pnpm')
  if (major === 12 && compareVersions(pnpm, '12.8.1') < 0) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: pnpm 12 is from 12.8.1 on`, 'host.pnpm')
  return major
}

// host.pnpm, or where it is left out the pnpm the root package.json's
// packageManager pins; `root` reads that package.json, called only then.
function pnpmOf(pnpm, root) {
  if (pnpm !== undefined && (typeof pnpm !== 'string' || pnpm === '')) throw new TypeError('host.pnpm must be a non-empty string, or left out')
  const version = pnpm ?? pinnedPnpm(root()?.packageManager)
  if (version === undefined) throw new TypeError('host.pnpm must be given where the root package.json\'s packageManager pins no pnpm')
  return { pnpm: version, major: majorOf(version) }
}

// All of host but its pnpm, which pnpmOf reads.
export function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with node, os, cpu and libc, and pnpm where it is not pinned')
  for (const key of ['node', 'os', 'cpu', 'libc']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  const { node, os, libc } = host
  if (valid(node) === null) throw new DeptreeError(`${quote(node)} is not an exact version`, 'host.node')
  if (os === 'win32') throw new DeptreeError('Windows is not supported: pnpm links there with junctions to absolute paths', 'host.os')
  if (!LIBC.has(libc)) throw new DeptreeError(`expected "glibc", "musl" or "unknown", found ${quote(libc)}`, 'host.libc')
  return { node, os, cpu: host.cpu, libc }
}

// Both files are YAML: unnamed, a refusal of one reads as one of the other.
function readNamed(file, read, text) {
  try {
    return read(text)
  } catch (error) {
    if (error instanceof LockfileError || error instanceof YamlError) throw new DeptreeError(error.message, file, { cause: error })
    throw error
  }
}

// pnpm 11 may write the env document alone, before any install.
export function readLockfile(text) {
  const read = readNamed('pnpm-lock.yaml', parsePnpmLockfile, text)
  if (read.lockfile === undefined) throw new DeptreeError('it holds the env document pnpm 11 writes alone, not the project\'s lockfile, which a frozen install cannot do without', 'pnpm-lock.yaml')
  return read
}

// One of comments alone, or empty, sets nothing, as pnpm reads it.
const readWorkspace = (text) => (text === undefined || /^(?:[\t ]*(?:#.*)?(?:\r?\n|$))*$/u.test(text) ? undefined : readNamed('pnpm-workspace.yaml', parseYaml, text))

// A root package.json that is a link is refused unread, as findProjects
// refuses it.
const ROOT = 'manifests["."]'
function readRoot(project) {
  if (typeOf(project, '/package.json', false) === 'symlink') throw linkedManifest('package.json')
  const text = readText(project, '/package.json', ROOT)
  return text === undefined ? undefined : readManifest(text, ROOT)
}

// Where there is no pnpm-workspace.yaml, pnpm 12 writes one whose packages
// are the root package.json's non-empty `workspaces` strings.
function workspaceOf(workspace, text, major, root) {
  if (major < 12 || text !== undefined) return workspace
  const listed = root()?.workspaces
  const packages = Array.isArray(listed) ? listed.filter((pattern) => typeof pattern === 'string' && pattern !== '') : []
  return packages.length === 0 ? workspace : { packages }
}

// Read before the rest of pnpm-workspace.yaml, to find the projects by.
function packagesOf(workspace) {
  if (workspace !== undefined && (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace))) throw new DeptreeError('expected a mapping', 'pnpm-workspace.yaml')
  return workspace?.packages === undefined ? undefined : readers.globs(workspace.packages, 'pnpm-workspace.yaml: packages')
}

// The directories of the projects pnpm finds in `project`: those whose
// package.json buildPnpmTree takes.
export function findPnpmProjects(options) {
  const { project, host } = options ?? {}
  checkProject(project)
  if (host !== undefined && (host === null || typeof host !== 'object')) throw new TypeError('host must be an object, or left out')
  const { major } = pnpmOf(host?.pnpm, () => readRoot(project))
  const text = readWorkspaceText(project)
  return findProjects(project, packagesOf(workspaceOf(readWorkspace(text), text, major, () => readRoot(project))), major)
}

const LOCKFILE = 'lockfile must be the text of pnpm-lock.yaml, or left out with a project given to read it from'

// The root files, given with `lockfile` or read from `project` without it.
export function inputsOf(options) {
  const { lockfile, manifests, workspace, npmrc, patches, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    for (const [name, value] of Object.entries({ manifests, workspace, npmrc, patches })) {
      if (value !== undefined) throw new TypeError(`${name} must be left out where lockfile is: both are read from project`)
    }
    return { reading: true, project, ...readRootFiles(project) }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  for (const [name, value] of Object.entries({ workspace, npmrc })) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
  }
  return { reading: false, lockfile, manifests, workspace, npmrc, patches }
}

// Each project's package.json, the pnpm that installs and the workspace:
// as given, or read for each project pnpm finds and no other. An importer
// the globs do not take is refused first; one they take that pnpm does
// not find has no package.json.
export function manifestsOf(inputs, lockfile, pnpm) {
  const workspace = readWorkspace(inputs.workspace)
  if (!inputs.reading) {
    const manifests = readManifests(inputs.manifests, lockfile)
    const installs = pnpmOf(pnpm, () => manifests.get('.'))
    return { manifests, ...installs, workspace: workspaceOf(workspace, inputs.workspace, installs.major, () => manifests.get('.')) }
  }
  const { project } = inputs
  const installs = pnpmOf(pnpm, () => readRoot(project))
  const effective = workspaceOf(workspace, inputs.workspace, installs.major, () => readRoot(project))
  const packages = packagesOf(effective)
  checkWorkspace(Object.keys(lockfile.importers), packages, installs.major)
  const ids = findProjects(project, packages, installs.major)
  return { manifests: readManifests(readManifestTexts(project, ids), lockfile), ...installs, workspace: effective }
}

// The patch texts by path, as given or read for patchedDependencies.
export function patchesOf(inputs, configured) {
  if (inputs.reading) return readPatches(inputs.project, configured)
  const entries = inputs.patches instanceof Map ? [...inputs.patches] : Object.entries(inputs.patches ?? {})
  for (const [path, text] of entries) {
    if (typeof text !== 'string') throw new TypeError(`patches[${quote(path)}] must be a string`)
  }
  return entries
}
