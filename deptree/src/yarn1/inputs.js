// What buildYarn1Tree takes, checked: the host, and the files an install
// reads, given as text or read from the project as yarn reads them.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { readManifest } from '../manifest.js'
import { checkProject, readText, typeOf } from '../project.js'
import { matchesGlob, reachesBelow } from './glob.js'
import { globsOf } from './manifest.js'
import { readSettings } from './settings.js'

// The yarn that installs: host.yarn, or else the one the root's
// packageManager pins, as corepack runs that one.
function yarnOf(yarn, root) {
  if (yarn !== undefined && (typeof yarn !== 'string' || yarn === '')) throw new TypeError('host.yarn must be a non-empty string, or left out')
  const { packageManager } = root
  let pinned
  if (packageManager !== undefined) {
    const match = typeof packageManager === 'string' ? /^([^@]+)@([^+]+)(?:\+.*)?$/u.exec(packageManager) : null
    if (match === null || match[1] !== 'yarn' || valid(match[2]) !== match[2]) throw new DeptreeError(`${quote(String(packageManager))} is not yarn at an exact version, which corepack would run instead`, 'manifests["."].packageManager')
    pinned = match[2]
  }
  const version = yarn ?? pinned
  if (version === undefined) throw new TypeError('host.yarn must be given where the root package.json\'s packageManager pins no yarn')
  if (pinned !== undefined && pinned !== version) throw new DeptreeError(`the project is installed by yarn ${pinned}, which corepack runs, not ${version}`, 'manifests["."].packageManager')
  if (!/^1\.22\.\d+$/u.test(version) || valid(version) !== version) throw new DeptreeError(`yarn ${quote(version)} is not supported: only yarn 1.22.x is`, 'host.yarn')
  return version
}

export function checkHost(host, root) {
  if (host === null || typeof host !== 'object') throw new TypeError('host must be an object with node, os and cpu, and yarn where it is not pinned')
  for (const key of ['node', 'os', 'cpu']) {
    if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
  }
  if (valid(host.node) !== host.node) throw new DeptreeError(`${quote(host.node)} is not an exact version`, 'host.node')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: yarn links bins there with shims, and workspaces with junctions', 'host.os')
  return { yarn: yarnOf(host.yarn, root), node: host.node, os: host.os, cpu: host.cpu }
}

// yarn reads a yarn.json beside each package.json it reads, or in its
// stead, as the manifest of its own registry.
const yarnJson = 'a yarn.json, which yarn reads as a manifest too, is not supported'

// The workspace directories as yarn's resolveWorkspaces finds them. A link
// where a glob may reach is refused, as node-glob follows it or not by
// where it is, and so is a node_modules a glob takes, whose package.json
// yarn would read.
function findWorkspaces(project, globs) {
  const found = []
  if (globs.length === 0) return found
  const pending = ['']
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const name of project.readdir(`/${dir}`)) {
      const path = dir === '' ? name : `${dir}/${name}`
      const taken = globs.some((glob) => matchesGlob(glob, path))
      if (!taken && !globs.some((glob) => reachesBelow(glob, path))) continue
      const { type } = project.lstat(`/${path}`)
      if (type === 'symlink') throw new DeptreeError('a link where yarn looks for workspaces is not supported', quote(path))
      if (type !== 'directory') continue
      const manifest = taken && typeOf(project, `/${path}/package.json`) !== undefined
      if (name === 'node_modules') {
        if (manifest) throw new DeptreeError('yarn would read this node_modules as a workspace, which is not supported', quote(path))
        continue
      }
      if (taken && typeOf(project, `/${path}/yarn.json`) !== undefined) throw new DeptreeError(yarnJson, quote(`${path}/yarn.json`))
      if (manifest) found.push(path)
      pending.push(path)
    }
  }
  return found.sort()
}

function readRoot(project) {
  const text = readText(project, '/package.json', 'manifests["."]')
  if (text === undefined) throw new DeptreeError('the project has no package.json at its root', 'manifests["."]')
  if (typeOf(project, '/yarn.json') !== undefined) throw new DeptreeError(yarnJson, 'yarn.json')
  return readManifest(text, 'manifests["."]')
}

export function findYarn1Workspaces(options) {
  const { project } = options ?? {}
  checkProject(project)
  return ['.', ...findWorkspaces(project, globsOf(readRoot(project)))]
}

const LOCKFILE = 'lockfile must be the text of yarn.lock, or left out with a project given to read it from'

export function inputsOf(options) {
  const { lockfile, manifests, yarnrc, npmrc, project } = options
  if (project !== undefined) checkProject(project)
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    for (const [name, value] of Object.entries({ manifests, yarnrc, npmrc })) {
      if (value !== undefined) throw new TypeError(`${name} must be left out where lockfile is: both are read from project`)
    }
    const text = readText(project, '/yarn.lock')
    if (text === undefined) throw new DeptreeError('the project has no yarn.lock, which a frozen install cannot do without')
    const read = new Map([['.', readRoot(project)]])
    for (const dir of findWorkspaces(project, globsOf(read.get('.')))) {
      read.set(dir, readManifest(readText(project, `/${dir}/package.json`, `manifests[${quote(dir)}]`), `manifests[${quote(dir)}]`))
    }
    if (typeOf(project, '/.yarnrc.yml') !== undefined) throw new DeptreeError('a .yarnrc.yml, whose yarnPath yarn 1.22 runs in its stead, is not supported', '.yarnrc.yml')
    return { lockfile: text, manifests: read, settings: readSettings({ yarnrc: readText(project, '/.yarnrc'), npmrc: readText(project, '/.npmrc') }), project }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (manifests === null || typeof manifests !== 'object') throw new TypeError('manifests must map each project\'s directory to its package.json')
  for (const [name, value] of Object.entries({ yarnrc, npmrc })) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
  }
  const settings = readSettings({ yarnrc, npmrc })
  const read = new Map()
  for (const [dir, text] of manifests instanceof Map ? manifests : Object.entries(manifests)) read.set(dir, readManifest(text, `manifests[${quote(dir)}]`))
  if (!read.has('.')) throw new DeptreeError('the root package.json is not given', 'manifests["."]')
  return { lockfile, manifests: read, settings, project }
}
