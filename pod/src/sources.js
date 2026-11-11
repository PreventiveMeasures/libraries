// The pods CocoaPods downloads into Pods/, each from the :http archive its podspec names, held to its sha256 and
// cleaned as CocoaPods leaves it: built by @preventive/deptree, and written out.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCocoaPodsTree } from '@preventive/deptree/cocoapods.js'
import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { PodError, quote } from './error.js'
import { prepareDownload } from './prepare.js'

// CocoaPods takes a pod's directory to be there where it holds a name that does not start with a `.`.
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

// Pods/Manifest.lock, CocoaPods' record of what it last installed; undefined where it is missing or unreadable.
export function readManifest(sandbox) {
  const manifest = join(sandbox, 'Manifest.lock')
  return existsSync(manifest) ? parsePodfileLock(readFileSync(manifest, 'utf8')).catch(() => undefined) : undefined
}

// The pods already in Pods/ at the lockfile's version, checksum and specs, which CocoaPods would not download again.
async function installedPods(sandbox, pods) {
  const before = await readManifest(sandbox)
  const same = (pod, root) => root !== undefined && root.version === pod.version && root.checksum === pod.checksum && root.pods.length === pod.specs.length && root.pods.every((name) => pod.specs.includes(name))
  return new Set(pods.filter((pod) => same(pod, before?.roots[pod.name]) && isThere(pod.dir)).map((pod) => pod.name))
}

// Downloads the pods of `input`, load.js's, that are neither local nor installed already; only those need a
// source held to a hash. Returns the names of those downloaded.
export async function fetchPods(input, github) {
  const { sandbox, lock, lockText, config } = input
  const remote = input.pods.filter((pod) => !pod.local)
  const there = await installedPods(sandbox, remote)
  const needed = remote.filter((pod) => !there.has(pod.name))
  if (needed.length === 0) return []
  // deptree is given only the pods needed: one already there is neither fetched again nor prepared.
  const podspecs = Object.fromEntries(needed.filter((pod) => pod.external).map((pod) => [pod.name, pod.bytes]))
  const host = { cocoapods: lock.cocoapods, os: process.platform }
  const only = needed.map((pod) => pod.name)
  const { vfs, installed, skipped } = await buildCocoaPodsTree({ lockfile: lockText.toString('utf8'), podspecs, host, platforms: [config.platform.name], github, partial: true, only, prepare: prepareDownload(config, lock.cocoapods) })
  const isNeeded = ({ name }) => only.includes(name)
  const refused = skipped.filter(isNeeded)
  if (refused.length > 0) throw new PodError(`${refused.length === 1 ? 'a pod is' : `${refused.length} pods are`} not downloaded:\n${refused.map(({ reason }) => `  ${reason}`).join('\n')}`)
  const built = installed.filter(isNeeded)
  const missing = needed.find((pod) => !built.some(({ name }) => name === pod.name))
  if (missing !== undefined) throw new PodError('is not downloaded', `pods[${quote(missing.name)}]`)
  for (const { name, path } of built) write(vfs, `/${path}`, join(sandbox, name))
  return built.map(({ name }) => name)
}
