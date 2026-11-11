// Stage 2: the pods' sources laid out in Pods/ as CocoaPods leaves them, by @preventive/deptree: each downloaded
// from the :http archive its podspec names, held to its sha256, prepared and cleaned.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCocoaPodsTree } from '@preventive/deptree/cocoapods.js'
import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { PodError, quote } from '../error.js'

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
function readManifest(sandbox) {
  const manifest = join(sandbox, 'Manifest.lock')
  return existsSync(manifest) ? parsePodfileLock(readFileSync(manifest, 'utf8')).catch(() => undefined) : undefined
}

// Whether `pod` is in Pods/ as the lockfile has it, by the manifest's `root` of it: CocoaPods downloads it no more.
const installed = (pod, root) => root !== undefined && root.version === pod.version && root.checksum === pod.checksum && root.pods.length === pod.specs.length && root.pods.every((name) => pod.specs.includes(name)) && isThere(pod.dir)

// `pods` are each pod's name, version, checksum, specs and directory, whether it is local, and the JSON of its
// podspec where it is by :podspec. `prepare` runs a prepare_command, for deptree. Returns the pods downloaded.
export async function layoutPods({ sandbox, lockfile, cocoapods, platform, pods }, github, prepare) {
  const before = await readManifest(sandbox)
  // The pods the last installation downloaded that this one does not have.
  for (const root of Object.values(before?.roots ?? {})) {
    if (root.external?.type !== 'path' && !pods.some((pod) => pod.name === root.name)) rmSync(join(sandbox, root.name), { recursive: true, force: true })
  }
  // Only what is downloaded needs a source held to a hash; a pod that is there is used as it is.
  const needed = pods.filter((pod) => !pod.local && !installed(pod, before?.roots[pod.name]))
  if (needed.length === 0) return []
  const podspecs = Object.fromEntries(needed.filter((pod) => pod.podspec !== undefined).map((pod) => [pod.name, pod.podspec]))
  // deptree is given only the pods needed: one already there is neither fetched again nor prepared.
  const only = needed.map((pod) => pod.name)
  const { vfs, installed: downloaded, skipped } = await buildCocoaPodsTree({ lockfile, podspecs, host: { cocoapods, os: process.platform }, platforms: [platform], github, partial: true, only, prepare })
  const isNeeded = ({ name }) => only.includes(name)
  const refused = skipped.filter(isNeeded)
  if (refused.length > 0) throw new PodError(`${refused.length === 1 ? 'a pod is' : `${refused.length} pods are`} not downloaded:\n${refused.map(({ reason }) => `  ${reason}`).join('\n')}`)
  const built = downloaded.filter(isNeeded)
  const missing = needed.find((pod) => !built.some(({ name }) => name === pod.name))
  if (missing !== undefined) throw new PodError('is not downloaded', `pods[${quote(missing.name)}]`)
  for (const { name, path } of built) write(vfs, `/${path}`, join(sandbox, name))
  return built.map(({ name }) => name)
}
