// What an installation is made from, read off the disk: the Podfile.lock, pod.config.json, the app's project, and
// each pod's podspec, as JSON or read without Ruby, held to the lockfile's checksum.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { readConfig } from './config.js'
import { PodError, quote } from './error.js'
import { dirGlob } from './files.js'
import { jsonSpecJson, toMaps } from './podspec-json.js'
import { podspecJson } from './podspec-read.js'
import { readSpec } from './spec.js'
import { readUserProject } from './user-project.js'

const read = (path) => (existsSync(path) ? readFileSync(path) : undefined)
const posixOf = (path) => path.split(sep).join('/')
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

function projectOf(dir, config) {
  const names = config.project === undefined ? readdirSync(dir).filter((name) => name.endsWith('.xcodeproj') && name !== 'Pods.xcodeproj') : [config.project]
  if (names.length !== 1) throw new PodError(names.length === 0 ? 'the directory has no .xcodeproj' : `the directory has more than one .xcodeproj, ${names.map(quote).join(', ')}: name one as \`project\``, 'pod.config.json')
  const path = resolve(dir, names[0])
  const text = read(join(path, 'project.pbxproj'))
  if (text === undefined) throw new PodError('has no project.pbxproj', names[0])
  // Its directory is its targets' SRCROOT, which need not be the Podfile's.
  return { name: names[0], dir: dirname(path), ...readUserProject(text.toString('utf8'), names[0]) }
}

// What a podspec read without Ruby may read of the disk (podspec-read.js's `files`).
const FILES = {
  read: (path) => read(path)?.toString('utf8'),
  glob: dirGlob,
  kind: (path) => {
    const stats = statSync(path, { throwIfNoEntry: false })
    return stats === undefined ? undefined : stats.isDirectory() ? 'directory' : 'file'
  },
}

// Where a pod's podspec is looked for, the first there taken: committed in `podspecs`, as JSON or Ruby; else
// where the lockfile has the pod from.
function podspecFiles(root, dir, podspecs) {
  const files = [join(podspecs, `${root.name}.podspec.json`), join(podspecs, `${root.name}.podspec`)]
  if (root.external?.type === 'podspec') files.push(resolve(dir, root.external.podspec))
  if (root.external?.type === 'path') {
    const path = resolve(dir, root.external.path)
    files.push(...(/\.podspec(?:\.json)?$/u.test(path) ? [path] : [join(path, `${root.name}.podspec`), join(path, `${root.name}.podspec.json`)]))
  }
  return files
}

// Each form CocoaPods may have kept the podspec in `file` in, as bytes: a JSON one as it is and as CocoaPods
// rewrites it; a Ruby one as podspec-read.js reads it.
function podspecForms(file, where, context) {
  const bytes = readFileSync(file)
  const text = bytes.toString('utf8')
  if (!file.endsWith('.json')) {
    const { forms, conditions } = podspecJson(file, text, FILES, where, context)
    return { forms: forms.map((json) => Buffer.from(json)), conditions }
  }
  try {
    return { forms: [bytes, ...jsonSpecJson(text).map((json) => Buffer.from(json))], conditions: [] }
  } catch {
    return { forms: [bytes], conditions: [] }
  }
}

// The form of a pod's podspec whose sha1 is the lockfile's checksum: what CocoaPods keeps as
// Pods/Local Podspecs/<name>.podspec.json.
function podspecOf(root, dir, podspecs, where, context) {
  const files = podspecFiles(root, dir, podspecs)
  const file = files.find((path) => existsSync(path))
  if (file === undefined) throw new PodError(`its podspec is not there, as ${files.map(quote).join(' or ')}`, where)
  const { forms, conditions } = podspecForms(file, `${where}: ${posixOf(relative(dir, file))}`, context)
  const bytes = forms.find((form) => sha1(form) === root.checksum)
  // A podspec that reads the environment may have been read in another one when the lockfile was written.
  const by = conditions.length === 0 ? '' : `, as read with ${conditions.join(', ')}`
  if (bytes === undefined) throw new PodError(`its podspec, ${quote(posixOf(relative(dir, file)))}, is not the one the lockfile has the checksum of: its sha1 is ${sha1(forms[0])}, not ${root.checksum}${by}`, where)
  return { bytes, root: readSpec(bytes, root.name, root.version, where) }
}

// `dir` is the directory of the Podfile.lock. Each pod has its root spec, its podspec's bytes, its directory and
// that from Pods/, and whether it is local, built where it is.
export async function load(dir) {
  const lockText = read(join(dir, 'Podfile.lock'))
  if (lockText === undefined) throw new PodError('the directory has no Podfile.lock', dir)
  const lock = await parsePodfileLock(lockText.toString('utf8'))
  const config = readConfig(read(join(dir, 'pod.config.json'))?.toString('utf8'))
  const user = projectOf(dir, config)
  const sandbox = join(dir, 'Pods')
  const podspecs = resolve(dir, config.podspecs)
  // podspec-read.js's context.
  const prebuilt = { core: lock.roots['React-Core-prebuilt'] !== undefined, deps: lock.roots.ReactNativeDependencies !== undefined }
  const globals = new Map(Object.entries(config.globals).map(([name, value]) => [name, toMaps(value)]))
  const context = { env: new Map(Object.entries(config.env)), globals, reactNative: lock.roots['React-Core']?.version, prebuilt, frameworks: config.frameworks, cocoapods: lock.cocoapods }
  const pods = Object.values(lock.roots).map((root) => {
    const where = `pods[${quote(root.name)}]`
    const local = root.external?.type === 'path'
    if (root.external !== undefined && !local && root.external.type !== 'podspec') throw new PodError(`a pod from an external source by :${root.external.type} is not supported: only those by :path and :podspec, and from trunk, are`, where)
    // A local pod's path may name its podspec rather than its directory.
    const podDir = local ? resolve(dir, root.external.path).replace(/[/\\][^/\\]+\.podspec(?:\.json)?$/u, '') : join(sandbox, root.name)
    const pod = { name: root.name, version: root.version, specs: root.pods, checksum: root.checksum, local, external: root.external !== undefined, dir: podDir, sandboxPath: posixOf(relative(sandbox, podDir)), ...podspecOf(root, dir, podspecs, where, context) }
    // CocoaPods runs a local pod's prepare_command in it at each installation; a pod by :path is the project's own
    // files, which no podspec's script is run in.
    if (local && typeof pod.root.attributes.prepare_command === 'string') throw new PodError('its podspec has a prepare_command, and the pod is one by :path, which is used where it is: CocoaPods would run the script in the pod\'s own directory at each installation, and none is run there here. The prepare_command has to be taken out of the podspec, and what it makes be in the pod already', where)
    return pod
  })
  return { dir, lock, lockText, config, user, sandbox, pods }
}
