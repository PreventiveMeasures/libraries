// The pods CocoaPods downloads into Pods/, each from the archive its podspec names by :http, held to its
// sha256, cleaned and locked as CocoaPods leaves it: built by @preventive/deptree, which refuses a source that
// is held to no hash, and written out.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCocoaPodsTree } from '@preventive/deptree/cocoapods.js'
import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { PodError, quote } from './error.js'
import { prepareDownload } from './prepare.js'

// A pod's directory is there where it holds a name that does not start with a `.`, as CocoaPods takes it.
const isThere = (dir) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith('.'))

function write(vfs, from, to) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const { path, type } of vfs.walk(from)) {
    if (path === from) continue
    const target = join(to, path.slice(from.length + 1))
    if (type === 'directory') mkdirSync(target, { recursive: true })
    else if (type === 'symlink') symlinkSync(vfs.readlink(path), target)
    else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, vfs.readFile(path))
      chmodSync(target, vfs.lstat(path).mode & 0o777)
    }
  }
}

// The pods Pods/ has as the lockfile has them, which CocoaPods would not download again: each that the
// Manifest.lock there, its record of what it installed, has at this version, checksum and specs, and whose
// directory is there.
async function installedPods(sandbox, pods) {
  const manifest = join(sandbox, 'Manifest.lock')
  if (!existsSync(manifest)) return new Set()
  const before = await parsePodfileLock(readFileSync(manifest, 'utf8')).catch(() => undefined)
  const same = (pod, root) => root !== undefined && root.version === pod.version && root.checksum === pod.checksum && root.pods.length === pod.specs.length && root.pods.every((name) => pod.specs.includes(name))
  return new Set(pods.filter((pod) => same(pod, before?.roots[pod.name]) && isThere(pod.dir)).map((pod) => pod.name))
}

// Downloads the pods of `input`, load.js's, that are neither local nor in Pods/ already as the lockfile has
// them. Only what is downloaded has to have a source held to a hash: a pod that is there, as a local one is, is
// used as it is, whatever source its podspec names. Returns the names of those downloaded.
export async function fetchPods(input, github) {
  const { sandbox, lock, lockText, config } = input
  const remote = input.pods.filter((pod) => !pod.local)
  const there = await installedPods(sandbox, remote)
  const needed = remote.filter((pod) => !there.has(pod.name))
  if (needed.length === 0) return []
  // A pod by :podspec that is not needed is given no podspec, so that deptree passes it over.
  const podspecs = Object.fromEntries(needed.filter((pod) => pod.external).map((pod) => [pod.name, pod.bytes]))
  const host = { cocoapods: lock.cocoapods, os: process.platform }
  const { vfs, installed, skipped } = await buildCocoaPodsTree({ lockfile: lockText.toString('utf8'), podspecs, host, platforms: [config.platform.name], github, partial: true, prepare: prepareDownload(config, lock.cocoapods) })
  const isNeeded = ({ name }) => needed.some((pod) => pod.name === name)
  const refused = skipped.filter(isNeeded)
  if (refused.length > 0) throw new PodError(`${refused.length === 1 ? 'a pod is' : `${refused.length} pods are`} not downloaded:\n${refused.map(({ reason }) => `  ${reason}`).join('\n')}`)
  const built = installed.filter(isNeeded)
  const missing = needed.find((pod) => !built.some(({ name }) => name === pod.name))
  if (missing !== undefined) throw new PodError('is not downloaded', `pods[${quote(missing.name)}]`)
  for (const { name, path } of built) write(vfs, `/${path}`, join(sandbox, name))
  return built.map(({ name }) => name)
}
