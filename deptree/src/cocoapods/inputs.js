// What buildCocoaPodsTree takes, as text or read from the project's root.

import { DeptreeError, quote } from '../error.js'
import { checkHostKeys, checkLeftOut, checkProject, readBytes, readText, typeOf } from '../project.js'

// CocoaPods 1.13.0 to 1.17.x, which download, clean and lock a pod alike:
// 1.16 copies a download into its cache with rsync where those before use
// FileUtils.cp_r, which come to the same of a checkout.
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

// The names CocoaPods reads a Podfile under, the first one there taken.
const PODFILES = ['CocoaPods.podfile.yaml', 'CocoaPods.podfile', 'Podfile', 'Podfile.rb']

const LOCKFILE = 'lockfile must be the Podfile.lock text, or left out where project is given'

export function inputsOf(options) {
  const { lockfile, podfile, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    checkLeftOut({ podfile }, 'both')
    const lock = readText(project, '/Podfile.lock', 'Podfile.lock')
    if (lock === undefined) throw new DeptreeError('the project has no Podfile.lock, without which CocoaPods resolves each pod anew')
    const name = PODFILES.find((candidate) => typeOf(project, `/${candidate}`) === 'file')
    if (name === undefined) throw new DeptreeError(`the project has no Podfile, as ${PODFILES.join(', ')}, without which CocoaPods installs nothing`)
    return { lockfile: lock, podfile: readBytes(project, `/${name}`) }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  if (podfile !== undefined && typeof podfile !== 'string' && !(podfile instanceof Uint8Array)) throw new TypeError('podfile must be the Podfile, as text or bytes, or left out')
  return { lockfile, podfile }
}
