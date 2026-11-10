// What an installation is made from, read off the disk: the Podfile.lock, pod.config.json, the app's project,
// and each pod's podspec, as JSON or in the form of one that is read without Ruby, held to the lockfile's
// checksum.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { readConfig } from './config.js'
import { PodError, quote } from './error.js'
import { jsonSpecJson } from './podspec-json.js'
import { podspecJson } from './podspec-read.js'
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
  return { name: names[0], dir, ...readUserProject(text.toString('utf8'), names[0]) }
}

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

// Where a pod's podspec is looked for, the first that is there taken: committed for it in the podspecs'
// directory, as the JSON CocoaPods wrote or as a podspec to read; else where the lockfile has the pod from, as
// CocoaPods finds it there.
function podspecFiles(root, dir, podspecs) {
  const files = [join(podspecs, `${root.name}.podspec.json`), join(podspecs, `${root.name}.podspec`)]
  if (root.external?.type === 'podspec') files.push(resolve(dir, root.external.podspec))
  if (root.external?.type === 'path') {
    const path = resolve(dir, root.external.path)
    files.push(...(/\.podspec(?:\.json)?$/u.test(path) ? [path] : [join(path, `${root.name}.podspec`), join(path, `${root.name}.podspec.json`)]))
  }
  return files
}

// What CocoaPods would keep of the podspec in `file`, as bytes, in each form it may have written it: a JSON one
// as it is, and as CocoaPods writes one it read; a Ruby one as podspec-read.js reads it, where it is in the
// form that is read.
function podspecForms(file, where) {
  const bytes = readFileSync(file)
  const text = bytes.toString('utf8')
  if (!file.endsWith('.json')) return podspecJson(file, text, (path) => read(path)?.toString('utf8'), where).map((json) => Buffer.from(json))
  try {
    return [bytes, ...jsonSpecJson(text).map((json) => Buffer.from(json))]
  } catch {
    return [bytes]
  }
}

// A pod's podspec, which has to be the one the lockfile has the checksum of, its sha1: the JSON CocoaPods
// keeps of it, as Pods/Local Podspecs/<name>.podspec.json.
function podspecOf(root, dir, podspecs, where) {
  const files = podspecFiles(root, dir, podspecs)
  const file = files.find((path) => existsSync(path))
  if (file === undefined) throw new PodError(`its podspec is not there, as ${files.map(quote).join(' or ')}`, where)
  const forms = podspecForms(file, `${where}: ${posixOf(relative(dir, file))}`)
  const bytes = forms.find((form) => sha1(form) === root.checksum)
  if (bytes === undefined) throw new PodError(`its podspec, ${quote(posixOf(relative(dir, file)))}, is not the one the lockfile has the checksum of: its sha1 is ${sha1(forms[0])}, not ${root.checksum}`, where)
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
    // A local pod is where its path says, or where the podspec is that its path names.
    const podDir = local ? resolve(dir, root.external.path).replace(/[/\\][^/\\]+\.podspec(?:\.json)?$/u, '') : join(sandbox, root.name)
    return { name: root.name, version: root.version, specs: root.pods, checksum: root.checksum, local, external: root.external !== undefined, dir: podDir, sandboxPath: posixOf(relative(sandbox, podDir)), ...podspecOf(root, dir, podspecs, where) }
  })
  return { dir, lock, lockText, config, user, sandbox, pods }
}
