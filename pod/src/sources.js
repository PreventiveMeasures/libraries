// The pods CocoaPods downloads into Pods/, each from the archive its podspec names by :http, held to its
// sha256, cleaned and locked as CocoaPods leaves it: built by @preventive/deptree, which refuses a source that
// is held to no hash, and written out.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildCocoaPodsTree } from '@preventive/deptree/cocoapods.js'

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

// Downloads the pods of `input`, load.js's, that are not local, unless Pods/ has them as the lockfile has them:
// its Manifest.lock is the lockfile, and each one's directory is there. Returns the names of those downloaded.
export async function fetchPods(input, github) {
  const { sandbox, lock, lockText, config } = input
  const downloaded = input.pods.filter((pod) => !pod.local)
  const manifest = join(sandbox, 'Manifest.lock')
  const current = existsSync(manifest) && readFileSync(manifest).equals(lockText)
  if (downloaded.length === 0 || (current && downloaded.every((pod) => isThere(pod.dir)))) return []
  const podspecs = Object.fromEntries(downloaded.filter((pod) => pod.external).map((pod) => [pod.name, pod.bytes]))
  const host = { cocoapods: lock.cocoapods, os: process.platform }
  const { vfs, installed, skipped } = await buildCocoaPodsTree({ lockfile: lockText.toString('utf8'), podspecs, host, platforms: [config.platform.name], github, partial: true, prepare: prepareDownload(config, lock.cocoapods) })
  const refused = skipped.filter(({ name }) => downloaded.some((pod) => pod.name === name))
  if (refused.length > 0) throw new PodError(`${refused.length === 1 ? 'a pod is' : `${refused.length} pods are`} not downloaded:\n${refused.map(({ reason }) => `  ${reason}`).join('\n')}`)
  for (const { name, path } of installed) write(vfs, `/${path}`, join(sandbox, name))
  const missing = downloaded.find((pod) => !installed.some(({ name }) => name === pod.name))
  if (missing !== undefined) throw new PodError('is not downloaded', `pods[${quote(missing.name)}]`)
  return installed.map(({ name }) => name)
}
