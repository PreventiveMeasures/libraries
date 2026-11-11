// Stage 2: the pods' sources laid out in Pods/ as CocoaPods leaves them: each downloaded from GitHub, by a commit or
// an :http archive held to its sha256, run through `prepare` where it has a prepare_command, and cleaned.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'
import { getPodArchive } from '@preventive/upstream/cocoapods.js'

import { PodError, quote } from '../error.js'
import { archiveOf } from './archive.js'
import { installPod, planPod } from './clean.js'
import { checkCloned, checkoutOf } from './github.js'
import { given, readPodspec, specNamed } from './podspec.js'
import { sourceOf } from './source.js'
import { fold } from './unicode.js'

// CocoaPods 1.13 to 1.17, which download, clean and lock a pod alike, but that before 1.16 a clone's .git is
// copied into the cache.
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

// The CocoaPods that downloads, and the machine: what a download is cleaned by.
function hostOf(cocoapods) {
  if (typeof cocoapods !== 'string' || !VERSION.test(cocoapods)) throw new PodError(`CocoaPods ${quote(String(cocoapods))} is not supported: only 1.13.0 to 1.17.x are`, 'Podfile.lock')
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new PodError(`${quote(process.platform)} is not supported: only macOS and Linux are`)
  return { folded: process.platform === 'darwin', keepsGit: Number(cocoapods.split('.')[1]) < 16 }
}

// What is downloaded of a pod, all of it worked out before anything is fetched: its source, its prepare_command,
// and what of its download it keeps.
function planOf(pod, platforms, folded) {
  const where = about(pod.name)
  if (pod.checkout) throw new PodError('a pod by :podspec that CocoaPods downloads by its CHECKOUT OPTIONS is not supported', where)
  if (!pod.external && !isTrunk(pod.repo)) throw new PodError(`a pod from the spec repo ${quote(String(pod.repo))} is not supported: only those from trunk are`, where)
  const key = folded ? fold : (name) => name
  if (GENERATED.some((name) => key(name) === key(pod.name)) || key(pod.name).endsWith(key('.xcodeproj'))) throw new PodError('a pod named as what CocoaPods writes beside the pods in Pods/ is not supported', where)
  // PodDirCleaner globs the pod's directory by its path as it is.
  if (/[*?[\]{}]/u.test(pod.name)) throw new PodError('a name with a glob\'s `*`, `?`, `[`, `]`, `{` or `}` in it, which CocoaPods cleans the pod by, is not supported', where)
  if (pod.name.length > 255) throw new PodError('a name too long for a directory, which CocoaPods fails to make', where)
  const podspec = readPodspec(pod.podspec, pod.name, pod.version, where)
  const source = sourceOf(podspec, where)
  const command = given(podspec.attributes.prepare_command) ? podspec.attributes.prepare_command : undefined
  if (command !== undefined && typeof command !== 'string') throw new PodError('its prepare_command is not text, which CocoaPods fails on', where)
  const specs = pod.specs.map((name) => specNamed(podspec, name) ?? podspecRefusal(name, where))
  return { pod, source, command, files: planPod(podspec, specs, platforms, where) }
}
function podspecRefusal(name, where) {
  throw new PodError(`its podspec has no ${quote(name)}, which the lockfile installs`, where)
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

// What a download comes to, fetched once for every pod of it: a checkout by its repository and commit, or an
// archive by its hash and what RemoteFile makes of it.
const downloadOf = ({ source }) => (source.type === 'git' ? `git ${source.repo}@${source.commit}` : `http ${source.sha256} ${source.file} ${source.flatten}`)
async function contentsOf({ pod, source }, github) {
  if (source.type === 'git') return await checkoutOf(github, source.repo, source.commit, about(pod.name))
  return await archiveOf(await getPodArchive(source.url, source.sha256), source, about(pod.name))
}

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
export async function layoutPods({ sandbox, cocoapods, platforms, pods }, github, prepare) {
  const before = await readManifest(sandbox)
  // The pods the last installation downloaded that this one does not have.
  for (const root of Object.values(before?.roots ?? {})) {
    if (root.external?.type !== 'path' && !pods.some((pod) => pod.name === root.name)) rmSync(join(sandbox, root.name), { recursive: true, force: true })
  }
  // Only what is downloaded needs a source held to a hash; a pod that is there is used as it is.
  const needed = pods.filter((pod) => !pod.local && !installed(pod, before?.roots[pod.name]))
  if (needed.length === 0) return []
  const { folded, keepsGit } = hostOf(cocoapods)
  const refusals = []
  const plans = needed.map((pod) => {
    try {
      return planOf(pod, platforms, folded)
    } catch (error) {
      if (!(error instanceof PodError)) throw error
      refusals.push(error.message)
      return undefined
    }
  })
  if (refusals.length > 0) throw new PodError(`${refusals.length === 1 ? 'a pod is' : `${refusals.length} pods are`} not downloaded:\n${refusals.map((reason) => `  ${reason}`).join('\n')}`)
  const git = plans.filter(({ source }) => source.type === 'git')
  await eachConcurrently(git, ({ pod, source }) => checkCloned(github, source.repo, source.commit, about(pod.name)), ({ pod }) => about(pod.name))
  const contents = new Map()
  await eachConcurrently(Map.groupBy(plans, downloadOf).values(), async (group) => {
    const download = await contentsOf(group[0], github)
    for (const { pod, command, files, source } of group) {
      const where = about(pod.name)
      const prepared = command === undefined ? download : await prepare({ name: pod.name, version: pod.version, command, contents: { dirs: new Set(download.dirs), files: new Map(download.files), links: new Map(download.links) } })
      // An archive is no clone, with no .git for CocoaPods to copy.
      contents.set(pod.name, installPod(prepared, files, { folded, keepsGit: keepsGit && source.type === 'git', where }))
    }
  }, ([{ pod }]) => about(pod.name))
  for (const pod of needed) writePod(contents.get(pod.name), join(sandbox, pod.name))
  return needed.map((pod) => pod.name)
}
