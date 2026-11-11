// Stage 1: each pod's podspec as the JSON CocoaPods keeps of it, Pods/Local Podspecs/<name>.podspec.json, from a
// JSON podspec or one read without Ruby (read.js), held to the lockfile's checksum.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { PodError, quote } from '../error.js'
import { dirGlob } from '../pathlist.js'
import { jsonSpecJson, toMaps } from './json.js'
import { podspecJson } from './read.js'

const posixOf = (path) => path.split(sep).join('/')
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

// What a podspec read without Ruby may read of the disk: read.js's `files`.
const FILES = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  glob: dirGlob,
  kind: (path) => {
    const stats = statSync(path, { throwIfNoEntry: false })
    return stats === undefined ? undefined : stats.isDirectory() ? 'directory' : 'file'
  },
}

// What a podspec is read in, read.js's `context`: of the lockfile, and of the config's `env` and `globals`.
export function contextOf(lock, config) {
  const prebuilt = { core: lock.roots['React-Core-prebuilt'] !== undefined, deps: lock.roots.ReactNativeDependencies !== undefined }
  const globals = new Map(Object.entries(config.globals).map(([name, value]) => [name, toMaps(value)]))
  return { env: new Map(Object.entries(config.env)), globals, reactNative: lock.roots['React-Core']?.version, prebuilt, frameworks: config.frameworks, cocoapods: lock.cocoapods }
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
// rewrites it; a Ruby one as read.js reads it.
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

// The JSON of the lockfile's `root`, the form of its podspec whose sha1 is the lockfile's checksum. `dir` is the
// lockfile's directory, `podspecs` that of the committed podspecs, `context` contextOf's.
export function podspecOf(root, dir, podspecs, where, context) {
  const files = podspecFiles(root, dir, podspecs)
  const file = files.find((path) => existsSync(path))
  if (file === undefined) throw new PodError(`its podspec is not at ${files.map(quote).join(' or ')}`, where)
  const { forms, conditions } = podspecForms(file, `${where}: ${posixOf(relative(dir, file))}`, context)
  const bytes = forms.find((form) => sha1(form) === root.checksum)
  // A podspec that reads the environment may have been read in another one when the lockfile was written.
  const by = conditions.length === 0 ? '' : `, as read with ${conditions.join(', ')}`
  if (bytes === undefined) throw new PodError(`its podspec, ${quote(posixOf(relative(dir, file)))}, has sha1 ${sha1(forms[0])}, not the lockfile's ${root.checksum}${by}`, where)
  return bytes
}
