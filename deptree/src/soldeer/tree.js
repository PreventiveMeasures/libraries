// The dependencies folder `soldeer install` makes from a soldeer.lock.

import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import { getZip } from '@preventive/upstream/soldeer.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { fold, makeDirs, mount, writeFiles } from '../mount.js'
import { configOf } from './config.js'
import { checkHost, inputsOf } from './inputs.js'
import { extractZip } from './zip.js'

// What the registry takes, as @preventive/upstream/soldeer.js checks a name
// and version, which Soldeer's sanitize_filename leaves as they are on Unix.
const NAME = /^(?=.{3,100}$)[@\da-z][\da-z-]*[\da-z]$/u
const VERSION = /^(?=.{1,128}$)[\dA-Za-z][\w.+-]*$/u

function checkNoDependencies(vfs, folded) {
  for (const name of vfs.readdir('/')) {
    if (name === 'dependencies' || (folded && fold(name) === 'dependencies')) {
      throw new DeptreeError('a dependencies folder is there already, which is neither kept beside the tree nor removed', `vfs[${quote(`/${name}`)}]`)
    }
  }
}

const about = (name) => `dependencies[${quote(name)}]`

function registryDependencies(lock, config, folded) {
  const dependencies = Object.values(lock.dependencies).map((dependency) => ({ ...dependency, folder: `${dependency.name}-${dependency.version}` }))
  const key = (folder) => (folded ? fold(folder) : folder)
  const folders = new Set(dependencies.map(({ folder }) => key(folder)))
  for (const { type, name, version } of dependencies) {
    const where = about(name)
    if (type === 'git') throw new DeptreeError('a git dependency, which Soldeer clones with its history, is not supported', where)
    if (type === 'private') throw new DeptreeError('a private dependency, which the registry hands out to those signed in alone, is not supported', where)
    if (config.dependencies?.[name]?.url !== undefined) throw new DeptreeError('a dependency from a URL of its own, rather than the registry, is not supported', where)
    if (!NAME.test(name)) throw new DeptreeError('a name the registry does not take', where)
    if (!VERSION.test(version)) throw new DeptreeError(`${quote(version)} is a version the registry does not take`, where)
  }
  for (const { name, folder } of dependencies) {
    if (folders.has(key(`${folder}.zip`))) throw new DeptreeError(`its zip is downloaded as ${quote(`${folder}.zip`)}, a folder Soldeer installs another dependency in`, about(name))
  }
  return dependencies
}

async function fetchAll(dependencies) {
  const extracted = new Map()
  await eachConcurrently(dependencies, async ({ name, version, checksum, folder }) => {
    extracted.set(folder, await extractZip(await getZip(name, version, checksum), checksum, about(name)))
  }, ({ name }) => about(name))
  return extracted
}

export async function buildSoldeerTree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoDependencies(into, folded)
  const config = configOf(inputs)
  const lock = parseSoldeerLockfile(inputs.lockfile, { config })
  const dependencies = registryDependencies(lock, config, folded)
  const extracted = await fetchAll(dependencies)
  const vfs = new Vfs()
  makeDirs(vfs, 'dependencies')
  const stats = { dependencies: dependencies.length, files: 0, bytes: 0 }
  // In the lockfile's order, whatever order the fetches finished in.
  for (const { folder } of dependencies) {
    writeFiles(vfs, `dependencies/${folder}`, extracted.get(folder), stats)
  }
  const installed = dependencies.map(({ name, version, checksum, folder }) => ({ path: `dependencies/${folder}`, name, version, checksum }))
  return { vfs: mount(vfs, into, folded, checkNoDependencies), stats, installed }
}
