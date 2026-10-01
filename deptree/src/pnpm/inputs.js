// What buildPnpmTree and findPnpmProjects take, checked: the host pnpm
// would install on, and the files an install reads — given as text, or
// read from the project (project.js) as pnpm reads them from disk.

import { LockfileError, YamlError, parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { checkProject, readManifestTexts, readPatches, readRootFiles, readText, readWorkspaceText, typeOf } from './project.js'
import { pinnedPnpm, readManifest, readManifests } from './projects.js'
import { readers } from './readers.js'
import { checkWorkspace, findProjects, linkedManifest } from './workspace.js'

const LIBC = new Set(['glibc', 'musl', 'unknown'])

// The major version of `pnpm`, 10 or 11: what pnpm 11 does differently is
// read by it, where it is.
function majorOf(pnpm) {
  const major = Number(valid(pnpm)?.split('.')[0])
  if (major !== 10 && major !== 11) throw new DeptreeError(`pnpm ${quote(pnpm)} is not supported: only pnpm 10 and 11 are`, 'host.pnpm')
  return major
}

// The pnpm that installs, and its major version: `pnpm`, host.pnpm, or
// where that is left out, the one the root package.json pins by its
// packageManager, which is the only one it takes; `root` gives that
// package.json as parsed, and is called only then.
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

// Before any install, pnpm 11 may write the env document alone, with no lockfile to install from.
export function readLockfile(text) {
  const read = readNamed('pnpm-lock.yaml', parsePnpmLockfile, text)
  if (read.lockfile === undefined) throw new DeptreeError('it holds the env document pnpm 11 writes alone, not the project\'s lockfile, which a frozen install cannot do without', 'pnpm-lock.yaml')
  return read
}

// pnpm-workspace.yaml as parsed; one of comments alone, or nothing, sets
// nothing, as pnpm reads it.
export const readWorkspace = (text) => (text === undefined || /^(?:[\t ]*(?:#.*)?(?:\r?\n|$))*$/u.test(text) ? undefined : readNamed('pnpm-workspace.yaml', parseYaml, text))

// The root package.json in `project`, as parsed, where there is one; one
// that is a link is refused unread, as findProjects refuses it.
const ROOT = 'manifests["."]'
function readRoot(project) {
  if (typeOf(project, '/package.json', false) === 'symlink') throw linkedManifest('package.json')
  const text = readText(project, '/package.json', ROOT)
  return text === undefined ? undefined : readManifest(text, ROOT)
}

// The packages of `workspace`, pnpm-workspace.yaml as parsed, read here
// before the rest of it is, to find the projects by.
function packagesOf(workspace) {
  if (workspace !== undefined && (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace))) throw new DeptreeError('expected a mapping', 'pnpm-workspace.yaml')
  return workspace?.packages === undefined ? undefined : readers.globs(workspace.packages, 'pnpm-workspace.yaml: packages')
}

// The directories of the projects pnpm finds in `project`, which
// buildPnpmTree takes the package.json of each of.
export function findPnpmProjects(options) {
  const { project, host } = options ?? {}
  checkProject(project)
  if (host !== undefined && (host === null || typeof host !== 'object')) throw new TypeError('host must be an object, or left out')
  const { major } = pnpmOf(host?.pnpm, () => readRoot(project))
  return findProjects(project, packagesOf(readWorkspace(readWorkspaceText(project))), major)
}

const LOCKFILE = 'lockfile must be the text of pnpm-lock.yaml, or left out with a project given to read it from'

// The files an install reads but the package.json and the patches: given,
// with `lockfile`, or read from `project` without it.
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

// The package.json of every project, and the pnpm that installs as pnpmOf
// reads it from the root one: as given, or read from the project for
// each project pnpm finds there, and no other, as pnpm reads them: an
// importer the globs do not take is refused first, and one they take that
// pnpm does not find has none. `workspace` is pnpm-workspace.yaml as
// parsed; `pnpm` host.pnpm.
export function manifestsOf(inputs, workspace, lockfile, pnpm) {
  if (!inputs.reading) {
    const manifests = readManifests(inputs.manifests, lockfile)
    return { manifests, ...pnpmOf(pnpm, () => manifests.get('.')) }
  }
  const { project } = inputs
  const installs = pnpmOf(pnpm, () => readRoot(project))
  const packages = packagesOf(workspace)
  checkWorkspace(Object.keys(lockfile.importers), packages, installs.major)
  const ids = findProjects(project, packages, installs.major)
  return { manifests: readManifests(readManifestTexts(project, ids), lockfile), ...installs }
}

// The patch files, by path: as given, or read from the project, each that
// `configured`, patchedDependencies, names.
export function patchesOf(inputs, configured) {
  if (inputs.reading) return readPatches(inputs.project, configured)
  const entries = inputs.patches instanceof Map ? [...inputs.patches] : Object.entries(inputs.patches ?? {})
  for (const [path, text] of entries) {
    if (typeof text !== 'string') throw new TypeError(`patches[${quote(path)}] must be a string`)
  }
  return entries
}
