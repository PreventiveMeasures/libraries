// What buildYarn1Tree takes, checked: the host yarn would install on, and
// the files an install reads — given as text, or read from the project
// (../pnpm/project.js) as yarn reads them from disk.

import { valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { checkProject, readText, typeOf } from '../pnpm/project.js'
import { matchesGlob, reachesBelow } from './glob.js'
import { cleanDependencies } from './requests.js'
import { readSettings } from './settings.js'

// The yarn that installs: host.yarn, or where that is left out, the one
// the root package.json's packageManager pins, as corepack runs that one;
// a 1.22.x, the line this follows.
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

// A package.json as yarn's readJson reads it: a byte order mark dropped.
export function readManifest(text, where) {
  if (typeof text !== 'string') throw new TypeError(`${where} must be the text of a package.json`)
  let manifest
  try {
    manifest = JSON.parse(text.replace(/^﻿/u, ''))
  } catch (error) {
    throw new DeptreeError(`not JSON: ${error.message}`, where, { cause: error })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('expected an object', where)
  return manifest
}

// The workspace globs of the root, as yarn reads them.
export function globsOf(root) {
  const value = root.workspaces
  if (value === undefined) return []
  return (Array.isArray(value) ? value : value?.packages ?? []).map((glob) => String(glob).replace(/^(?:\.\/)+|\/+$/gu, ''))
}

// yarn reads a yarn.json beside each package.json it reads, or in its
// stead, as the manifest of its own registry.
const yarnJson = 'a yarn.json, which yarn reads as a manifest too, is not supported'

// The directories of the workspaces in `project` as yarn's resolveWorkspaces
// finds them: each with a package.json that a glob takes, outside
// node_modules. Every directory a glob may reach is read; a link in one,
// which node-glob follows or not by where it is, is refused, and so is a
// node_modules a glob would take, whose package.json yarn would read.
export function findWorkspaces(project, globs) {
  const found = []
  if (globs.length === 0) return found
  const pending = ['']
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const name of project.readdir(`/${dir}`)) {
      const path = dir === '' ? name : `${dir}/${name}`
      if (!globs.some((glob) => reachesBelow(glob, path) || matchesGlob(glob, path))) continue
      const { type } = project.lstat(`/${path}`)
      if (type === 'symlink') throw new DeptreeError('a link where yarn looks for workspaces is not supported', quote(path))
      if (type !== 'directory') continue
      if (name === 'node_modules') {
        if (globs.some((glob) => matchesGlob(glob, path)) && typeOf(project, `/${path}/package.json`) !== undefined) throw new DeptreeError('yarn would read this node_modules as a workspace, which is not supported', quote(path))
        continue
      }
      if (globs.some((glob) => matchesGlob(glob, path))) {
        if (typeOf(project, `/${path}/yarn.json`) !== undefined) throw new DeptreeError(yarnJson, quote(`${path}/yarn.json`))
        if (typeOf(project, `/${path}/package.json`) !== undefined) found.push(path)
      }
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

// The directories of the projects yarn installs in `project`: `.`, then
// each workspace's, as buildYarn1Tree takes their package.json given.
export function findYarn1Workspaces(options) {
  const { project } = options ?? {}
  checkProject(project)
  return ['.', ...findWorkspaces(project, globsOf(readRoot(project)))]
}

const LOCKFILE = 'lockfile must be the text of yarn.lock, or left out with a project given to read it from'

// The files an install reads, given or read from the project: yarn.lock,
// each package.json by directory, the root's `.` among them, and what of
// the .yarnrc and .npmrc the install follows.
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
    const rc = readText(project, '/.yarnrc')
    const npm = readText(project, '/.npmrc')
    return { lockfile: text, manifests: read, settings: readSettings({ yarnrc: rc, npmrc: npm }), project }
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

// The lists of a package.json this reads, as yarn's normalize-manifest
// leaves them: a `//` key, a comment, dropped, a value that is not one
// given as `''`, and a name in several of the dependency lists kept in
// one (cleanDependencies). A copy; the manifest is left as it is.
const LISTS = ['resolutions', 'devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']
export function fixLists(manifest) {
  const fixed = { ...manifest }
  for (const kind of LISTS) {
    const list = manifest[kind]
    if (!list || typeof list !== 'object') continue
    const copy = Array.isArray(list) ? [...list] : { ...list }
    delete copy['//']
    for (const name in copy) copy[name] = copy[name] || ''
    fixed[kind] = copy
  }
  return cleanDependencies(fixed)
}

// What yarn's normalize-manifest fails on in the root's name and version,
// which the lockfile reader does not read; and what of the root yarn would
// install otherwise than this follows.
const NAME = /[/@\s+%:]/u
const validName = (name) => !NAME.test(name) && encodeURIComponent(name) === name
export function checkRoot(root) {
  const { name, version } = root
  for (const [key, value] of Object.entries({ name, version })) {
    if (value && typeof value !== 'string') throw new DeptreeError('not a string, which yarn fails on', `manifests["."].${key}`)
  }
  if (typeof name === 'string') {
    const parts = name.startsWith('@') ? name.slice(1).split('/') : undefined
    const legal = parts === undefined ? validName(name) : parts.length === 2 && parts.every(validName)
    if (name.startsWith('.') || !legal || ['node_modules', 'favicon.ico'].includes(name.toLowerCase())) throw new DeptreeError(`${quote(name)} is a name yarn fails on`, 'manifests["."].name')
  }
  if (root.installConfig?.pnp) throw new DeptreeError('Plug\'n\'Play is not supported', 'manifests["."].installConfig.pnp')
  if (root.flat) throw new DeptreeError('a flat install is not supported', 'manifests["."].flat')
  const nohoist = root.workspaces?.nohoist
  if (Array.isArray(nohoist) && nohoist.length > 0) throw new DeptreeError('nohoist is not supported', 'manifests["."].workspaces.nohoist')
}
