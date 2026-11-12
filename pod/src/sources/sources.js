// Stage 2: the pods' sources laid out in Pods/ as CocoaPods leaves them: each the :http archive its podspec names,
// held to its sha256, run through `prepare` where it has a prepare_command, and cleaned.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'

import { PodError, quote } from '../error.js'
import { archiveOf, downloadArchive } from './archive.js'
import { installPod, planPod } from './clean.js'
import { given, readPodspec, specNamed } from './podspec.js'
import { fold } from './podtree.js'
import { sourceOf } from './source.js'

// CocoaPods 1.13 to 1.17, which download, clean and lock an archive alike.
const VERSION = /^1\.1[3-7]\.\d+$/u
// What CocoaPods writes in Pods/ beside the pods, which a pod's directory would be one with.
const GENERATED = ['Headers', 'Local Podspecs', 'Manifest.lock', 'Target Support Files']
// Trunk, as SPEC REPOS names it, or the git repository of its podspecs, whose CDN serves the same files.
const isTrunk = (repo) => repo === 'trunk' || /^https:\/\/github\.com\/cocoapods\/specs(?:\.git)?$/iu.test(repo ?? '')
const CONCURRENCY = 16

const about = (name) => `pods[${quote(name)}]`
// CocoaPods takes a pod's directory to be there where it holds a name that does not start with a `.`.
const isThere = (dir) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith('.'))

// Pods/Manifest.lock, CocoaPods' record of what it last installed; undefined where it is missing or unreadable.
function readManifest(sandbox) {
  const manifest = join(sandbox, 'Manifest.lock')
  return existsSync(manifest) ? parsePodfileLock(readFileSync(manifest, 'utf8')).catch(() => undefined) : undefined
}

// Whether `pod` is in Pods/ as the lockfile has it, by the manifest's `root` of it: CocoaPods downloads it no more.
const installed = (pod, root) => root !== undefined && root.version === pod.version && root.checksum === pod.checksum && root.pods.length === pod.specs.length && root.pods.every((name) => pod.specs.includes(name)) && isThere(pod.dir)

// Whether names fold as on macOS: the CocoaPods that downloads, and the machine, are what a download is cleaned by.
function foldedOn(cocoapods) {
  if (typeof cocoapods !== 'string' || !VERSION.test(cocoapods)) throw new PodError(`CocoaPods ${quote(String(cocoapods))} is not supported: only 1.13.0 to 1.17.x are`, 'Podfile.lock')
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new PodError(`${quote(process.platform)} is not supported: only macOS and Linux are`)
  return process.platform === 'darwin'
}

// What is downloaded of a pod, all of it worked out before anything is fetched: its source, its prepare_command,
// and what of its download it keeps. `key` is a name as the machine finds it.
function planOf(pod, platform, key) {
  const where = about(pod.name)
  if (pod.checkout) throw new PodError('CHECKOUT OPTIONS are not supported', where)
  if (!pod.external && !isTrunk(pod.repo)) throw new PodError(`the spec repo ${quote(String(pod.repo))} is not trunk`, where)
  if (GENERATED.some((name) => key(name) === key(pod.name)) || key(pod.name).endsWith(key('.xcodeproj'))) throw new PodError('its name is one CocoaPods uses in Pods/', where)
  // PodDirCleaner globs the pod's directory by its path as it is.
  if (/[*?[\]{}]/u.test(pod.name)) throw new PodError('its name has glob characters', where)
  if (pod.name.length > 255) throw new PodError('its name is too long for a directory', where)
  const podspec = readPodspec(pod.podspec)
  const source = sourceOf(podspec, where)
  const command = given(podspec.attributes.prepare_command) ? podspec.attributes.prepare_command : undefined
  if (command !== undefined && typeof command !== 'string') throw new PodError('its prepare_command is not text', where)
  const specs = pod.specs.map((name) => specNamed(podspec, name) ?? podspecRefusal(name, where))
  return { pod, source, command, files: planPod(podspec, specs, platform) }
}
function podspecRefusal(name, where) {
  throw new PodError(`its podspec has no ${quote(name)}`, where)
}

// `job` of each of `items`, a few at a time; the first failure thrown once each started has ended, as a PodError
// about `whereOf(item)`.
async function eachConcurrently(items, job, whereOf) {
  const queue = [...items]
  let failure
  const work = async () => {
    while (queue.length > 0 && failure === undefined) {
      const item = queue.shift()
      try {
        await job(item)
      } catch (error) {
        failure ??= error instanceof PodError ? error : new PodError(error.message, whereOf(item), { cause: error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, work))
  if (failure !== undefined) throw failure
}

// What a download comes to, fetched once for every pod of it: an archive, by its hash and what RemoteFile makes of it.
const downloadOf = ({ source }) => `${source.sha256} ${source.file} ${source.flatten}`

// A pod's directory written out: its directories, its files with their modes, then its links, so that nothing is
// written through one.
function writePod({ dirs, files, links }, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const path of dirs) mkdirSync(join(dir, path), { recursive: true })
  for (const [path, { data, mode }] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), data)
    chmodSync(join(dir, path), mode)
  }
  for (const [path, target] of links) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    symlinkSync(target, join(dir, path))
  }
}

// `pods` are each pod's name, version, checksum, specs and directory, whether it is local or external, its spec
// repo, whether CHECKOUT OPTIONS has it, and its podspec's JSON. `prepare` runs a prepare_command (prepare/).
export async function layoutPods({ sandbox, cocoapods, platform, pods }, prepare) {
  const before = await readManifest(sandbox)
  // The pods the last installation downloaded that this one does not have.
  for (const root of Object.values(before?.roots ?? {})) {
    if (root.external?.type !== 'path' && !pods.some((pod) => pod.name === root.name)) rmSync(join(sandbox, root.name), { recursive: true, force: true })
  }
  // Only what is downloaded needs a source held to a hash; a pod that is there is used as it is.
  const needed = pods.filter((pod) => !pod.local && !installed(pod, before?.roots[pod.name]))
  if (needed.length === 0) return []
  const folded = foldedOn(cocoapods)
  const key = (name) => (folded ? fold(name) : name)
  const refusals = []
  // Each pod's directory is Pods/<name>, which on macOS two names may share.
  const named = new Map()
  for (const { name } of pods.filter((pod) => !pod.local)) {
    if (named.has(key(name))) refusals.push(`${about(name)}: ${quote(named.get(key(name)))} and ${quote(name)} are one name on macOS`)
    named.set(key(name), name)
  }
  const plans = needed.map((pod) => {
    try {
      return planOf(pod, platform, key)
    } catch (error) {
      if (!(error instanceof PodError)) throw error
      refusals.push(error.message)
      return undefined
    }
  })
  if (refusals.length > 0) throw new PodError(`${refusals.length === 1 ? 'a pod is' : `${refusals.length} pods are`} not downloaded:\n${refusals.map((reason) => `  ${reason}`).join('\n')}`)
  const contents = new Map()
  await eachConcurrently(Map.groupBy(plans, downloadOf).values(), async (group) => {
    const { pod, source } = group[0]
    const download = await archiveOf(await downloadArchive(source.url, source.sha256, about(pod.name)), source, about(pod.name))
    for (const { pod: one, command, files } of group) {
      const prepared = command === undefined ? download : await prepare({ name: one.name, version: one.version, command, contents: { dirs: new Set(download.dirs), files: new Map(download.files), links: new Map(download.links) } })
      contents.set(one.name, installPod(prepared, files, { folded, where: about(one.name) }))
    }
  }, ([{ pod }]) => about(pod.name))
  for (const pod of needed) writePod(contents.get(pod.name), join(sandbox, pod.name))
  return needed.map((pod) => pod.name)
}
