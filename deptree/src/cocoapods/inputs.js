// What buildCocoaPodsTree takes, as text or read from the project's root.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { DeptreeError, quote } from '../error.js'
import { checkHostKeys, checkLeftOut, checkProject, readBytes, readText, typeOf } from '../project.js'
import { isObject } from './podspec.js'

// CocoaPods 1.13.0 to 1.17.x, which download, clean and lock a pod alike
// but for one thing, which tree.js follows: 1.16 on copy a download into
// their cache with rsync, which leaves the clone's .git out, where those
// before use FileUtils.cp_r, which copies it.
const VERSION = /^1\.1[3-7]\.\d+$/u

export function checkHost(host) {
  checkHostKeys(host, ['cocoapods', 'os'], 'cocoapods and os')
  if (!VERSION.test(host.cocoapods)) throw new DeptreeError(`CocoaPods ${quote(host.cocoapods)} is not supported: only 1.13.0 to 1.17.x are`, 'host.cocoapods')
  if (host.os !== 'darwin' && host.os !== 'linux') throw new DeptreeError(`${quote(host.os)} is not supported: only macOS and Linux are`, 'host.os')
  return { cocoapods: host.cocoapods, os: host.os }
}

// What the Podfile's targets are for, as Platform names them, each once;
// undefined for any.
const PLATFORMS = new Set(['ios', 'osx', 'tvos', 'visionos', 'watchos'])
const PLATFORMS_TYPE = 'platforms must be a non-empty list of ios, osx, tvos, visionos and watchos, each once, or left out'
export function platformsOf(platforms) {
  if (platforms === undefined) return undefined
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((name) => !PLATFORMS.has(name)) || new Set(platforms).size !== platforms.length) throw new TypeError(PLATFORMS_TYPE)
  return [...platforms]
}

// `manifest` and `partial`, each false unless given true.
export function flagsOf({ manifest = false, partial = false }) {
  for (const [name, value] of Object.entries({ manifest, partial })) if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean, or left out`)
  return { manifest, partial }
}

// `only`, the names of the pods to download, each once; undefined for every
// pod there is.
const ONLY = 'only must be a list of the names of pods, each once, or left out'
export function onlyOf(only) {
  if (only === undefined) return undefined
  if (!Array.isArray(only) || only.some((name) => typeof name !== 'string') || new Set(only).size !== only.length) throw new TypeError(ONLY)
  return new Set(only)
}

// The names CocoaPods reads a Podfile under, the first one there taken.
const PODFILES = ['CocoaPods.podfile.yaml', 'CocoaPods.podfile', 'Podfile', 'Podfile.rb']

const LOCKFILE = 'lockfile must be the Podfile.lock text, or left out where project is given'

// The podspecs of pods by :podspec, as CocoaPods writes each in Pods/Local
// Podspecs, by name: those given, as text or bytes, or else those in the
// project's Pods/Local Podspecs; undefined for one neither has.
const PODSPECS = 'podspecs must be an object of podspecs by name, each as text or bytes, or left out'
function podspecsOf(podspecs, project) {
  if (podspecs !== undefined) {
    if (!isObject(podspecs)) throw new TypeError(PODSPECS)
    const given = new Map(Object.entries(podspecs))
    for (const value of given.values()) if (!(typeof value === 'string' ? value.isWellFormed() : value instanceof Uint8Array)) throw new TypeError(PODSPECS)
    return (name) => {
      const value = given.get(name)
      return typeof value === 'string' ? utf8fromString(value) : value
    }
  }
  if (project === undefined) return () => undefined
  return (name) => {
    const path = `/Pods/Local Podspecs/${name}.podspec.json`
    return typeOf(project, path) === 'file' ? readBytes(project, path) : undefined
  }
}

export function inputsOf(options) {
  const { lockfile, podfile, project } = options
  const podspecs = podspecsOf(options.podspecs, project)
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    checkLeftOut({ podfile }, 'both')
    const lock = readText(project, '/Podfile.lock', 'Podfile.lock')
    if (lock === undefined) throw new DeptreeError('the project has no Podfile.lock, without which CocoaPods resolves each pod anew')
    const name = PODFILES.find((candidate) => typeOf(project, `/${candidate}`) === 'file')
    if (name === undefined) throw new DeptreeError(`the project has no Podfile, as ${PODFILES.join(', ')}, without which CocoaPods installs nothing`)
    return { lockfile: lock, podfile: readBytes(project, `/${name}`), podspecs }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  if (podfile !== undefined && typeof podfile !== 'string' && !(podfile instanceof Uint8Array)) throw new TypeError('podfile must be the Podfile, as text or bytes, or left out')
  return { lockfile, podfile, podspecs }
}
