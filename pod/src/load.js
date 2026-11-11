// What an installation is made from, read off the disk: the Podfile.lock, pod.config.json, the app's project, and
// each pod's podspec as the JSON the lockfile has the checksum of (stage 1, podspec/).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { readConfig } from './config.js'
import { PodError, quote } from './error.js'
import { readSpec, readUserProject } from './generate/generate.js'
import { contextOf, podspecOf } from './podspec/podspec.js'

const read = (path) => (existsSync(path) ? readFileSync(path) : undefined)
const posixOf = (path) => path.split(sep).join('/')

function projectOf(dir, config) {
  const names = config.project === undefined ? readdirSync(dir).filter((name) => name.endsWith('.xcodeproj') && name !== 'Pods.xcodeproj') : [config.project]
  if (names.length !== 1) throw new PodError(names.length === 0 ? 'the directory has no .xcodeproj' : `the directory has more than one .xcodeproj, ${names.map(quote).join(', ')}: name one as \`project\``, 'pod.config.json')
  const path = resolve(dir, names[0])
  const text = read(join(path, 'project.pbxproj'))
  if (text === undefined) throw new PodError('has no project.pbxproj', names[0])
  // Its directory is its targets' SRCROOT, which need not be the Podfile's.
  return { name: names[0], dir: dirname(path), ...readUserProject(text.toString('utf8'), names[0]) }
}

// `dir` is the directory of the Podfile.lock. Each pod has its podspec's JSON and root spec, its directory and that
// from Pods/, and whether it is local, built where it is.
export async function load(dir) {
  const lockText = read(join(dir, 'Podfile.lock'))
  if (lockText === undefined) throw new PodError('the directory has no Podfile.lock', dir)
  const lock = await parsePodfileLock(lockText.toString('utf8'))
  const config = readConfig(read(join(dir, 'pod.config.json'))?.toString('utf8'))
  const user = projectOf(dir, config)
  const sandbox = join(dir, 'Pods')
  const podspecs = resolve(dir, config.podspecs)
  const context = contextOf(lock, config)
  const pods = Object.values(lock.roots).map((root) => {
    const where = `pods[${quote(root.name)}]`
    const local = root.external?.type === 'path'
    if (root.external !== undefined && !local && root.external.type !== 'podspec') throw new PodError(`a :${root.external.type} source is not supported`, where)
    // A local pod's path may name its podspec rather than its directory.
    const podDir = local ? resolve(dir, root.external.path).replace(/[/\\][^/\\]+\.podspec(?:\.json)?$/u, '') : join(sandbox, root.name)
    const bytes = podspecOf(root, dir, podspecs, where, context)
    return { name: root.name, version: root.version, specs: root.pods, checksum: root.checksum, local, external: root.external !== undefined, dir: podDir, sandboxPath: posixOf(relative(sandbox, podDir)), bytes, root: readSpec(bytes, root.name, root.version, where) }
  })
  return { dir, lock, lockText, config, user, sandbox, pods }
}
