// The dependencies folder `soldeer install` makes from a soldeer.lock.

import { utf8fromStringLoose } from '@exodus/bytes/utf8.js'
import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import { getZip } from '@preventive/upstream/soldeer.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkNoDir, fold, makeDirs, mount, writeFiles } from '../mount.js'
import { configOf } from './config.js'
import { checkoutOf, githubRepoOf } from './git.js'
import { checkHost, inputsOf } from './inputs.js'
import { extractZip } from './zip.js'

// What the registry takes, as @preventive/upstream/soldeer.js checks a name
// and version, which Soldeer's sanitize_filename leaves as they are on Unix.
const NAME = /^(?=.{3,100}$)[@\da-z][\da-z-]*[\da-z]$/u
const VERSION = /^(?=.{1,128}$)[\dA-Za-z][\w.+-]*$/u
// A folder sanitize_filename leaves as it is on Unix: none of the characters
// it replaces, and at most 255 bytes, past which it cuts the name short.
const isKept = (folder) => !/[/?<>\\:*|"\p{Cc}]/u.test(folder) && utf8fromStringLoose(folder).length <= 255

const GITHUB = 'github must be a GitHub client from createClient, which a git dependency is fetched through'

const checkNoDependencies = checkNoDir('dependencies', 'a dependencies folder')

const about = (name) => `dependencies[${quote(name)}]`

function checkDependency({ type, name, version, git, folder }, config) {
  const where = about(name)
  if (type === 'private') throw new DeptreeError('a private dependency, which the registry hands out to those signed in alone, is not supported', where)
  if (type === 'git') {
    if (githubRepoOf(git) === undefined) throw new DeptreeError(`a git dependency from ${quote(git)}, not a GitHub repository over https or ssh, is not supported`, where)
    if (!isKept(folder)) throw new DeptreeError(`its folder, ${quote(folder)}, is one Soldeer names otherwise, which is not supported`, where)
    return
  }
  if (config.dependencies?.[name]?.url !== undefined) throw new DeptreeError('a dependency from a URL of its own, rather than the registry, is not supported', where)
  if (!NAME.test(name)) throw new DeptreeError('a name the registry does not take', where)
  if (!VERSION.test(version)) throw new DeptreeError(`${quote(version)} is a version the registry does not take`, where)
}

function dependenciesOf(lock, config, folded) {
  const dependencies = Object.values(lock.dependencies).map((dependency) => ({ ...dependency, folder: `${dependency.name}-${dependency.version}` }))
  for (const dependency of dependencies) checkDependency(dependency, config)
  const key = (folder) => (folded ? fold(folder) : folder)
  const folders = new Set(dependencies.map(({ folder }) => key(folder)))
  for (const { type, name, folder } of dependencies) {
    if (type === 'http' && folders.has(key(`${folder}.zip`))) throw new DeptreeError(`its zip is downloaded as ${quote(`${folder}.zip`)}, a folder Soldeer installs another dependency in`, about(name))
  }
  return dependencies
}

async function fetchAll(dependencies, github) {
  const extracted = new Map()
  await eachConcurrently(dependencies, async ({ type, name, version, checksum, git, rev, folder }) => {
    const where = about(name)
    extracted.set(folder, type === 'git' ? await checkoutOf(github, githubRepoOf(git), rev, where) : await extractZip(await getZip(name, version, checksum), checksum, where))
  }, ({ name }) => about(name))
  return extracted
}

export async function buildSoldeerTree(options) {
  const { host: given, vfs: into, github } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  if (github !== undefined && typeof github?.getRepoTarball !== 'function') throw new TypeError(GITHUB)
  const inputs = inputsOf(options ?? {})
  const folded = checkHost(given).os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoDependencies(into, folded)
  const config = configOf(inputs)
  const dependencies = dependenciesOf(parseSoldeerLockfile(inputs.lockfile, { config }), config, folded)
  if (github === undefined && dependencies.some(({ type }) => type === 'git')) throw new TypeError(GITHUB)
  const extracted = await fetchAll(dependencies, github)
  const vfs = new Vfs()
  makeDirs(vfs, 'dependencies')
  const stats = { dependencies: dependencies.length, files: 0, bytes: 0, links: 0 }
  // In the lockfile's order, whatever order the fetches finished in.
  for (const { folder } of dependencies) {
    writeFiles(vfs, `dependencies/${folder}`, extracted.get(folder), stats)
  }
  const installed = dependencies.map(({ type, name, version, checksum, git, rev, folder }) => ({ path: `dependencies/${folder}`, name, version, ...(type === 'git' ? { git, rev } : { checksum }) }))
  return { vfs: mount(vfs, into, folded, checkNoDependencies), stats, installed }
}
