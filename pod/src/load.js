// What an installation is made from, read off the disk: the Podfile.lock, pod.config.json, the app's project,
// and each pod's podspec, the JSON committed for it, held to the lockfile's checksum.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { readConfig } from './config.js'
import { PodError, quote } from './error.js'
import { readSpec } from './spec.js'
import { readUserProject } from './user-project.js'

const read = (path) => (existsSync(path) ? readFileSync(path) : undefined)
const posixOf = (path) => path.split(sep).join('/')

function projectOf(dir, config) {
  const names = config.project === undefined ? readdirSync(dir).filter((name) => name.endsWith('.xcodeproj') && name !== 'Pods.xcodeproj') : [config.project]
  if (names.length !== 1) throw new PodError(names.length === 0 ? 'the directory has no .xcodeproj' : `the directory has more than one .xcodeproj, ${names.map(quote).join(', ')}: name one as \`project\``, 'pod.config.json')
  const path = join(dir, names[0], 'project.pbxproj')
  const text = read(path)
  if (text === undefined) throw new PodError('has no project.pbxproj', names[0])
  return { name: names[0], ...readUserProject(text.toString('utf8'), names[0]) }
}

// A pod's podspec, which has to be the one the lockfile has the checksum of, its sha1.
function podspecOf(root, dir, where) {
  const path = join(dir, `${root.name}.podspec.json`)
  const bytes = read(path)
  if (bytes === undefined) throw new PodError(`its podspec is not there, as ${quote(path)}: the JSON CocoaPods writes of it as Pods/Local Podspecs/${root.name}.podspec.json`, where)
  const sum = createHash('sha1').update(bytes).digest('hex')
  if (sum !== root.checksum) throw new PodError(`its podspec is not the one the lockfile has the checksum of: its sha1 is ${sum}, not ${root.checksum}`, where)
  return { bytes, root: readSpec(bytes, root.name, root.version, where) }
}

// `dir` is the directory of the Podfile.lock, the app's `ios`. Each pod comes with its root spec, its podspec's
// bytes, its directory, that from Pods/, and whether it is a local one, which is built where it is.
export async function load(dir) {
  const lockText = read(join(dir, 'Podfile.lock'))
  if (lockText === undefined) throw new PodError('the directory has no Podfile.lock', dir)
  const lock = await parsePodfileLock(lockText.toString('utf8'))
  const config = readConfig(read(join(dir, 'pod.config.json'))?.toString('utf8'))
  const user = projectOf(dir, config)
  const sandbox = join(dir, 'Pods')
  const podspecs = resolve(dir, config.podspecs)
  const pods = Object.values(lock.roots).map((root) => {
    const where = `pods[${quote(root.name)}]`
    const local = root.external?.type === 'path'
    if (root.external !== undefined && !local && root.external.type !== 'podspec') throw new PodError(`a pod from an external source by :${root.external.type} is not supported: only those by :path and :podspec, and from trunk, are`, where)
    const podDir = local ? resolve(dir, root.external.path) : join(sandbox, root.name)
    return { name: root.name, version: root.version, specs: root.pods, checksum: root.checksum, local, dir: podDir, sandboxPath: posixOf(relative(sandbox, podDir)), ...podspecOf(root, podspecs, where) }
  })
  return { dir, lock, lockText, config, user, sandbox, pods }
}
