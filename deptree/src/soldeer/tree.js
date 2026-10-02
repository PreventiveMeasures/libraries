// The dependencies folder `soldeer install` makes from a soldeer.lock: each
// registry dependency's zip fetched, held to the lockfile's checksum, and
// extracted in a folder of its own (zip.js).

import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import { getZip } from '@preventive/upstream/soldeer.js'
import { Vfs, VfsError } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote, refusalOf } from '../error.js'
import { checkCollisions, fold, mount } from '../mount.js'
import { configOf } from './config.js'
import { checkHost, inputsOf } from './inputs.js'
import { extractZip } from './zip.js'

// What the registry takes, as @preventive/upstream/soldeer.js holds a name
// and a version to: of these, Soldeer's sanitize_filename leaves a folder
// `<name>-<version>` as it is on Unix.
const NAME = /^(?=.{3,100}$)[@\da-z][\da-z-]*[\da-z]$/u
const VERSION = /^(?=.{1,128}$)[\dA-Za-z][\w.+-]*$/u

// Refuses a Vfs that holds a dependencies folder at its root, or, where
// names are `folded`, a name that is one there.
function checkNoDependencies(vfs, folded) {
  for (const name of vfs.readdir('/')) {
    if (name === 'dependencies' || (folded && fold(name) === 'dependencies')) {
      throw new DeptreeError('a dependencies folder is there already, which is neither kept beside the tree nor removed', `vfs[${quote(`/${name}`)}]`)
    }
  }
}

// The registry dependencies, each with the folder Soldeer installs it in;
// any other kind is refused. Where names are `folded`, a folder is one
// with another that differs from it only in case or normalization.
function registryDependencies(lock, config, folded) {
  const dependencies = Object.values(lock.dependencies).map((dependency) => ({ ...dependency, folder: `${dependency.name}-${dependency.version}` }))
  const key = (folder) => (folded ? fold(folder) : folder)
  const folders = new Set(dependencies.map(({ folder }) => key(folder)))
  for (const { type, name, version } of dependencies) {
    const where = `dependencies[${quote(name)}]`
    if (type === 'git') throw new DeptreeError('a git dependency, which Soldeer clones with its history, is not supported', where)
    if (type === 'private') throw new DeptreeError('a private dependency, which the registry hands out to those signed in alone, is not supported', where)
    if (config.dependencies?.[name]?.url !== undefined) throw new DeptreeError('a dependency from a URL of its own, rather than the registry, is not supported', where)
    if (!NAME.test(name)) throw new DeptreeError('a name the registry does not take', where)
    if (!VERSION.test(version)) throw new DeptreeError(`${quote(version)} is a version the registry does not take`, where)
  }
  // Soldeer downloads each zip beside the folders, as `<folder>.zip`.
  for (const { name, folder } of dependencies) {
    if (folders.has(key(`${folder}.zip`))) throw new DeptreeError(`its zip is downloaded as ${quote(`${folder}.zip`)}, a folder Soldeer installs another dependency in`, `dependencies[${quote(name)}]`)
  }
  return dependencies
}

// Each dependency's zip, fetched and extracted a few at a time, by its
// folder.
async function fetchAll(dependencies) {
  const extracted = new Map()
  await eachConcurrently(dependencies, async ({ name, version, checksum, folder }) => {
    const where = `dependencies[${quote(name)}]`
    try {
      extracted.set(folder, await extractZip(await getZip(name, version, checksum), where))
    } catch (error) {
      throw refusalOf(error, where)
    }
  })
  return extracted
}

function writeTree(extracted) {
  const vfs = new Vfs()
  vfs.mkdir('/dependencies')
  let files = 0
  let bytes = 0
  for (const [folder, { dirs, files: written }] of extracted) {
    const root = `/dependencies/${folder}`
    vfs.mkdir(root)
    for (const dir of dirs) vfs.mkdir(`${root}/${dir}`, { recursive: true })
    for (const [path, file] of written) {
      try {
        vfs.writeFile(`${root}/${path}`, file.data, { mode: file.mode })
      } catch (error) {
        if (error instanceof VfsError) throw new DeptreeError(`cannot be written: ${error.message}`, quote(`dependencies/${folder}/${path}`), { cause: error })
        throw error
      }
      files++
      bytes += file.data.length
    }
  }
  return { vfs, files, bytes }
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
  // In the lockfile's order, whatever order the fetches finished in.
  const { vfs, files, bytes } = writeTree(dependencies.map(({ folder }) => [folder, extracted.get(folder)]))
  if (folded) checkCollisions(vfs)
  const stats = { dependencies: dependencies.length, files, bytes }
  const installed = dependencies.map(({ name, version, checksum, folder }) => ({ path: `dependencies/${folder}`, name, version, checksum }))
  if (into === undefined) return { vfs, stats, installed }
  mount(vfs, into, folded, checkNoDependencies)
  return { vfs: into, stats, installed }
}
