// What buildYarn1Tree takes, as text or read from the project as yarn does.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { readManifest, readManifests } from '../manifest.js'
import { checkHostKeys, checkLeftOut, checkProject, checkTexts, readText, typeOf } from '../project.js'
import { walkWorkspaces } from '../glob.js'
import { globsOf } from './manifest.js'
import { readSettings } from './settings.js'

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
  checkHostKeys(host, ['node', 'os', 'cpu'])
  if (valid(host.node) !== host.node) throw new DeptreeError(`${quote(host.node)} is not an exact version`, 'host.node')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: yarn links bins there with shims, and workspaces with junctions', 'host.os')
  return { yarn: yarnOf(host.yarn, root), node: host.node, os: host.os, cpu: host.cpu }
}

const yarnJson = 'a yarn.json, which yarn reads as a manifest too, is not supported'

// As yarn's resolveWorkspaces finds them.
function findWorkspaces(project, globs) {
  return walkWorkspaces(project, globs, {
    manager: 'yarn',
    enter: (path, name, taken, manifest) => {
      if (name === 'node_modules' && manifest) throw new DeptreeError('yarn would read this node_modules as a workspace, which is not supported', quote(path))
      if (name !== 'node_modules' && taken && typeOf(project, `/${path}/yarn.json`) !== undefined) throw new DeptreeError(yarnJson, quote(`${path}/yarn.json`))
      return name !== 'node_modules'
    },
  })
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
    checkLeftOut({ manifests, yarnrc, npmrc })
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
  checkTexts({ yarnrc, npmrc })
  const settings = readSettings({ yarnrc, npmrc })
  return { lockfile, manifests: readManifests(manifests), settings, project }
}
