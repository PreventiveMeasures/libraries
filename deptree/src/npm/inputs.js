// The host, and the files `npm ci` reads, given or read from the project.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { walkWorkspaces } from '../glob.js'
import { readManifest, readManifests } from '../manifest.js'
import { checkProject, readText, typeOf } from '../project.js'
import { readSettings } from './settings.js'
import { profileOf } from './versions.js'

const LIBCS = new Set(['glibc', 'musl'])

export function checkHost(host) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with npm, node, os and cpu, and libc on Linux')
  for (const key of ['npm', 'node', 'os', 'cpu']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  if (valid(host.node) !== host.node) throw new DeptreeError(`${quote(host.node)} is not an exact version`, 'host.node')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: npm links bins there with shims, and workspaces with junctions', 'host.os')
  if (host.os === 'linux' ? !LIBCS.has(host.libc) : host.libc !== undefined) {
    throw new TypeError(host.os === 'linux' ? 'host.libc must be glibc or musl on Linux' : 'host.libc must be left out but on Linux')
  }
  return { ...profileOf(host.npm), node: host.node, os: host.os, cpu: host.cpu, libc: host.libc }
}

// As @npmcli/map-workspaces reads them; the lockfile reader refuses one
// that negates.
function globsOf(root) {
  const { workspaces = [] } = root
  const globs = Array.isArray(workspaces?.packages) ? workspaces.packages : workspaces
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== 'string')) throw new DeptreeError('expected a sequence of globs, which npm fails without', 'manifests["."].workspaces')
  return globs.map((glob) => glob.replace(/^\.?\/+/u, ''))
}

// As map-workspaces globs, ignoring node_modules, and on macOS case.
function findWorkspaces(project, globs, nocase) {
  return walkWorkspaces(project, globs, { manager: 'npm', fold: nocase ? (path) => path.toLowerCase() : undefined, skip: (name) => name === 'node_modules' })
}

const where = (dir) => `manifests[${quote(dir)}]`

function readManifestAt(project, dir) {
  const text = readText(project, dir === '.' ? '/package.json' : `/${dir}/package.json`, where(dir))
  if (text === undefined) throw new DeptreeError('the project has no package.json at its root', where(dir))
  return readManifest(text, where(dir))
}

export function findNpmWorkspaces(options) {
  const { project, os } = options ?? {}
  checkProject(project)
  return ['.', ...findWorkspaces(project, globsOf(readManifestAt(project, '.')), os === 'darwin')]
}

const LOCKFILE = 'lockfile must be the text of package-lock.json, or left out with a project given to read it from'

function readProject(project, nocase) {
  if (typeOf(project, '/npm-shrinkwrap.json', false) !== undefined) throw new DeptreeError('an npm-shrinkwrap.json, which npm reads in place of package-lock.json, is not supported', 'npm-shrinkwrap.json')
  const lockfile = readText(project, '/package-lock.json')
  if (lockfile === undefined) throw new DeptreeError('the project has no package-lock.json, which npm ci cannot do without')
  const manifests = new Map([['.', readManifestAt(project, '.')]])
  for (const dir of findWorkspaces(project, globsOf(manifests.get('.')), nocase)) manifests.set(dir, readManifestAt(project, dir))
  return { lockfile, manifests, settings: readSettings(readText(project, '/.npmrc', '.npmrc')) }
}

export function inputsOf(options, nocase) {
  const { lockfile, manifests, npmrc, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    for (const [name, value] of Object.entries({ manifests, npmrc })) {
      if (value !== undefined) throw new TypeError(`${name} must be left out where lockfile is: both are read from project`)
    }
    return readProject(project, nocase)
  }
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (manifests === null || typeof manifests !== 'object') throw new TypeError('manifests must map each project\'s directory to its package.json')
  if (npmrc !== undefined && typeof npmrc !== 'string') throw new TypeError('npmrc must be a string, or left out')
  return { lockfile, manifests: readManifests(manifests), settings: readSettings(npmrc) }
}
