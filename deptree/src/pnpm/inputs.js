// The host and the files an install reads, checked, as given or read from the
// project as pnpm reads them from disk.

import { LockfileError, YamlError, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { checkHostKeys, checkLeftOut, checkProject, checkTexts, readText, typeOf } from '../project.js'
import { pinnedPnpm, readManifests } from './projects.js'
import { readers } from './readers.js'
import { checkWorkspace, findProjects, linkedManifest } from './workspace.js'

const LIBC = new Set(['glibc', 'musl', 'unknown'])

const MISNAMED = ['pnpm-workspaces.yaml', 'pnpm-workspaces.yml', 'pnpm-workspace.yml', '.pnpm-workspace.yaml', '.pnpm-workspace.yml', '.pnpm-workspaces.yaml', '.pnpm-workspaces.yml']
const MISNAMED_9 = ['pnpm-workspace.yml']
function readWorkspaceText(project, major) {
  const text = readText(project, '/pnpm-workspace.yaml')
  const misnamed = text === undefined ? (major < 10 ? MISNAMED_9 : MISNAMED).find((name) => typeOf(project, `/${name}`) === 'file') : undefined
  if (misnamed !== undefined) throw new DeptreeError('pnpm refuses a workspace manifest not named pnpm-workspace.yaml', quote(misnamed))
  return text
}

// pnpm-workspace.yaml is read once the pnpm that installs is known.
function readRootFiles(project) {
  const lockfile = readText(project, '/pnpm-lock.yaml')
  if (lockfile === undefined) throw new DeptreeError('the project has no pnpm-lock.yaml, which a frozen install cannot do without')
  return { lockfile, npmrc: readText(project, '/.npmrc') }
}

function readManifestTexts(project, ids) {
  const texts = new Map()
  for (const id of ids) {
    texts.set(id, readText(project, id === '.' ? '/package.json' : `/${id}/package.json`, `manifests[${quote(id)}]`))
  }
  return texts
}

// By path from the lockfile's directory; one that is not there is left out.
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

// pnpm 9 before 9.15.0, and pnpm 12 before 12.8.1, install otherwise in
// places, and are refused.
const SINCE = { 9: '9.15.0', 12: '12.8.1' }
function majorOf(pnpm) {
  const major = Number(valid(pnpm)?.split('.')[0])
  if (major < 9 || major > 12 || !Number.isInteger(major)) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: only pnpm 9, 10, 11 and 12 are`, 'host.pnpm')
  if (major in SINCE && compareVersions(pnpm, SINCE[major]) < 0) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: pnpm ${major} is from ${SINCE[major]} on`, 'host.pnpm')
  return major
}

// `root` reads the root package.json, only where host.pnpm is left out.
function pnpmOf(pnpm, root) {
  if (pnpm !== undefined && (typeof pnpm !== 'string' || pnpm === '')) throw new TypeError('host.pnpm must be a non-empty string, or left out')
  const version = pnpm ?? pinnedPnpm(root()?.packageManager)
  if (version === undefined) throw new TypeError('host.pnpm must be given where the root package.json\'s packageManager pins no pnpm')
  return { pnpm: version, major: majorOf(version) }
}

// All of host but its pnpm, which pnpmOf reads.
export function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with node, os, cpu and libc, and pnpm where it is not pinned')
  checkHostKeys(host, ['node', 'os', 'cpu', 'libc'])
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

export function readLockfile(text) {
  const read = readNamed('pnpm-lock.yaml', parsePnpmLockfile, text)
  if (read.lockfile === undefined) throw new DeptreeError('it holds the env document pnpm 11 writes alone, not the project\'s lockfile, which a frozen install cannot do without', 'pnpm-lock.yaml')
  return read
}

// One of comments alone, or empty, sets nothing, as pnpm reads it.
const readWorkspace = (text) => (text === undefined || /^(?:[\t ]*(?:#.*)?(?:\r?\n|$))*$/u.test(text) ? undefined : readNamed('pnpm-workspace.yaml', parseYaml, text))

// A root package.json that is a link is refused unread, as findProjects does.
const ROOT = 'manifests["."]'
function readRoot(project) {
  if (typeOf(project, '/package.json', false) === 'symlink') throw linkedManifest('package.json')
  const text = readText(project, '/package.json', ROOT)
  return text === undefined ? undefined : readManifest(text, ROOT)
}

// Where there is no pnpm-workspace.yaml, pnpm 12 writes one whose packages are
// the root package.json's non-empty `workspaces` strings. pnpm 9 takes one that
// sets nothing for `**`.
function workspaceOf(workspace, text, major, root) {
  if (major < 10) {
    const mapping = workspace !== null && typeof workspace === 'object' && !Array.isArray(workspace)
    if (text !== undefined && (workspace == null || (mapping && Object.keys(workspace).length === 0))) return { packages: ['**'] }
    if (mapping && !workspace.packages) throw new DeptreeError('pnpm 9 fails on a workspace manifest that sets anything and no packages', 'pnpm-workspace.yaml: packages')
    return workspace
  }
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

// The pnpm that installs and the workspace it reads, from disk, with the root
// package.json read at most once.
function readInstalls(project, pnpm) {
  let read
  const root = () => (read ??= readRoot(project))
  const installs = pnpmOf(pnpm, root)
  const text = readWorkspaceText(project, installs.major)
  const workspace = workspaceOf(readWorkspace(text), text, installs.major, root)
  return { ...installs, workspace, packages: packagesOf(workspace) }
}

// The directories of the projects whose package.json buildPnpmTree takes.
export function findPnpmProjects(options) {
  const { project, host } = options ?? {}
  checkProject(project)
  if (host !== undefined && (host === null || typeof host !== 'object')) throw new TypeError('host must be an object, or left out')
  const { major, packages } = readInstalls(project, host?.pnpm)
  return findProjects(project, packages, major)
}

const LOCKFILE = 'lockfile must be the text of pnpm-lock.yaml, or left out with a project given to read it from'

export function inputsOf(options) {
  const { lockfile, manifests, workspace, npmrc, patches, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkLeftOut({ manifests, workspace, npmrc, patches })
    return { reading: true, project, ...readRootFiles(project) }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  checkTexts({ workspace, npmrc })
  return { reading: false, lockfile, manifests, workspace, npmrc, patches }
}

// An importer the globs do not take is refused first; one they take that pnpm
// does not find has no package.json.
export function manifestsOf(inputs, lockfile, pnpm) {
  if (!inputs.reading) {
    const workspace = readWorkspace(inputs.workspace)
    const manifests = readManifests(inputs.manifests, lockfile)
    const installs = pnpmOf(pnpm, () => manifests.get('.'))
    return { manifests, ...installs, workspace: workspaceOf(workspace, inputs.workspace, installs.major, () => manifests.get('.')) }
  }
  const { project } = inputs
  const { packages, ...installs } = readInstalls(project, pnpm)
  checkWorkspace(Object.keys(lockfile.importers), packages, installs.major)
  const ids = findProjects(project, packages, installs.major)
  return { manifests: readManifests(readManifestTexts(project, ids), lockfile), ...installs }
}

export function patchesOf(inputs, configured) {
  if (inputs.reading) return readPatches(inputs.project, configured)
  const entries = inputs.patches instanceof Map ? [...inputs.patches] : Object.entries(inputs.patches ?? {})
  for (const [path, text] of entries) {
    if (typeof text !== 'string') throw new TypeError(`patches[${quote(path)}] must be a string`)
  }
  return entries
}
