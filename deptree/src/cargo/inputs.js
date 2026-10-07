// What buildCargoTree takes, as text or read from the project's root. Texts
// given are laid out as the project they stand for, so that both are read
// one way.

import { Vfs } from '@preventive/vfs'
import { DeptreeError, quote } from '../error.js'
import { UNSAFE, isInside } from '../mount.js'
import { checkHostKeys, checkLeftOut, checkProject, checkTexts, readText, typeOf } from '../project.js'

// 1.94 to 1.99 vendor alike, but for the `$comment` 1.97 and later write.
const VERSION = /^1\.(9[4-9])\.(?:0|[1-9]\d*)$/u

export function checkHost(host) {
  checkHostKeys(host, ['cargo', 'os'], 'cargo and os')
  const minor = VERSION.exec(host.cargo)?.[1]
  if (minor === undefined) throw new DeptreeError(`cargo ${quote(host.cargo)} is not supported: only cargo 1.94.0 to 1.99.x are`, 'host.cargo')
  if (host.os === 'win32') throw new DeptreeError('Windows is not supported: cargo unpacks and names files otherwise there', 'host.os')
  return { cargo: host.cargo, os: host.os, comment: Number(minor) >= 97 }
}

// A file cargo reads, by its path from the root, as text, or undefined where
// there is none: a link at it or on the way to it is refused, so that nothing
// is read from outside the project's view.
export function readUnlinked(project, file, what) {
  const segments = file.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const path = segments.slice(0, i).join('/')
    const type = typeOf(project, `/${path}`, false)
    if (type === undefined) return undefined
    if (type === 'symlink') throw new DeptreeError(`a link where cargo reads ${what} is not supported`, quote(path))
  }
  return readText(project, `/${file}`, file)
}

// Cargo reads .cargo/config where it is, in .cargo/config.toml's stead.
function readConfig(project) {
  for (const file of ['.cargo/config', '.cargo/config.toml']) {
    const text = readUnlinked(project, file, 'its config')
    if (text !== undefined) return { text, file }
  }
  return { text: undefined, file: '.cargo/config.toml' }
}

const MANIFESTS = 'manifests must map each directory, "." for the root, to the text of its Cargo.toml'

// `.` or a path below the root, as a Cargo.toml's directory is named.
function given(manifests) {
  if (manifests === null || typeof manifests !== 'object') throw new TypeError(MANIFESTS)
  const vfs = new Vfs()
  const dirs = new Set()
  for (const [dir, text] of manifests instanceof Map ? manifests : Object.entries(manifests)) {
    if (typeof dir !== 'string' || typeof text !== 'string') throw new TypeError(MANIFESTS)
    if (dir !== '.' && (!isInside(dir) || UNSAFE.test(dir))) throw new DeptreeError('not a directory below the root, as it is named here', `manifests[${quote(dir)}]`)
    const path = dir === '.' ? '' : `/${dir}`
    if (path !== '') vfs.mkdir(path, { recursive: true })
    vfs.writeFile(`${path}/Cargo.toml`, text)
    dirs.add(dir)
  }
  return { vfs, dirs }
}

const LOCKFILE = 'lockfile must be the Cargo.lock text, or left out where project is given'

// `project` the view manifests are read from, and `given` the directories
// of those given, which have to be those read.
export function inputsOf(options) {
  const { lockfile, manifests, config, project } = options
  if (lockfile === undefined) {
    if (project === undefined) throw new TypeError(LOCKFILE)
    checkProject(project)
    checkLeftOut({ manifests, config }, 'all')
    const lock = readUnlinked(project, 'Cargo.lock', 'its lockfile')
    if (lock === undefined) throw new DeptreeError('the project has no Cargo.lock, without which cargo resolves every dependency anew')
    return { lockfile: lock, config: readConfig(project), project, given: undefined }
  }
  if (typeof lockfile !== 'string') throw new TypeError(LOCKFILE)
  if (project !== undefined) throw new TypeError('project must be left out where lockfile is given')
  checkTexts({ config })
  const { vfs, dirs } = given(manifests)
  return { lockfile, config: { text: config, file: '.cargo/config.toml' }, project: vfs, given: dirs }
}
