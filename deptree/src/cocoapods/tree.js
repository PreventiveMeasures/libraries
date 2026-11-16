// The pods `pod install` downloads into Pods/ from a Podfile.lock.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'
import { getPodArchive, getPodspec } from '@preventive/upstream/cocoapods.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkCloned, checkoutOf } from '../github.js'
import { sha1Hex } from '../hash.js'
import { checkNoDir, fold, makeDirs, mount, writeFiles } from '../mount.js'
import { archiveOf } from './archive.js'
import { checkHost, flagsOf, inputsOf, onlyOf, platformsOf } from './inputs.js'
import { installPod, planPod } from './install.js'
import { given, readPodspec, specNamed } from './podspec.js'
import { SourceRefusal, sourceOf } from './source.js'

const GITHUB = 'github must be a GitHub client from createClient, which each pod is fetched through'
const GITHUB_METHODS = ['getRepo', 'compareCommits', 'getCommitTree', 'getRepoTreeTarball']

// Trunk, as SPEC REPOS names it from 1.8, or by the git repository of its podspecs, as before
const isTrunk = (repo) => repo === 'trunk' || /^https:\/\/github\.com\/cocoapods\/specs(?:\.git)?$/iu.test(repo)

// What CocoaPods writes in Pods/ beside the pods, Pods.xcodeproj among generate_multiple_pod_projects'
const GENERATED = ['Headers', 'Local Podspecs', 'Manifest.lock', 'Target Support Files']
const isGenerated = (name, key) => GENERATED.some((other) => key(other) === key(name)) || key(name).endsWith(key('.xcodeproj'))

const checkNoPods = checkNoDir('Pods', 'a Pods directory')

const about = (name) => `pods[${quote(name)}]`

// True for a root CocoaPods downloads into Pods/, from trunk or by :podspec (unless by CHECKOUT OPTIONS,
// refused); false for one by :path, read where it is; any other refused
function isDownloaded(root, folded) {
  const where = about(root.name)
  if (root.external?.type === 'path') return false
  if (root.external?.type === 'podspec' && root.checkout !== undefined) throw new SourceRefusal('a pod by :podspec that CocoaPods downloads by its CHECKOUT OPTIONS is not supported', where)
  if (root.external !== undefined && root.external.type !== 'podspec') throw new SourceRefusal(`a pod from an external source by :${root.external.type} is not supported: only those from trunk, by :podspec and by :path are`, where)
  if (root.external === undefined && !isTrunk(root.repo)) throw new SourceRefusal(`a pod from the spec repo ${quote(root.repo)} is not supported: only those from trunk are`, where)
  if (isGenerated(root.name, folded ? fold : (name) => name)) throw new DeptreeError('a pod named as what CocoaPods writes beside the pods in Pods/ is not supported', where)
  // PodDirCleaner globs the pod's directory by its path as it is
  if (/[*?[\]{}]/u.test(root.name)) throw new DeptreeError('a name with a glob\'s `*`, `?`, `[`, `]`, `{` or `}` in it, which CocoaPods cleans the pod by, is not supported', where)
  // ASCII, as the lockfile reader holds a pod's name to.
  if (root.name.length > 255) throw new DeptreeError('a name too long for a directory, which CocoaPods fails to make', where)
  return true
}

function refuse(detail, where) {
  throw new DeptreeError(detail, where)
}

// What `attempt` gives or comes to; with `partial` (`skipped`), undefined for a SourceRefusal, kept there
function unlessSkipped(attempt, root, skipped) {
  const skip = (error) => {
    if (skipped === undefined || !(error instanceof SourceRefusal)) throw error
    skipped.set(root.name, error.message)
    return undefined
  }
  try {
    const result = attempt()
    return result instanceof Promise ? result.catch(skip) : result
  } catch (error) {
    return skip(error)
  }
}

// The podspec of a pod by :podspec, held to the lockfile's checksum, its sha1
async function localPodspec(root, podspecs, where) {
  const bytes = podspecs(root.name)
  if (bytes === undefined) throw new SourceRefusal(`its podspec, the JSON CocoaPods writes as Pods/Local Podspecs/${root.name}.podspec.json, is not given`, where)
  const sum = await sha1Hex(bytes)
  if (sum !== root.checksum) throw new DeptreeError(`its podspec given is not the one the lockfile has the checksum of: its sha1 is ${sum}, not ${root.checksum}`, where)
  return bytes
}

// Each root's podspec, source and plan, before any download, so a pod refused costs none; a pod skipped
// for its source has no plan, its podspec held to the lockfile all the same
async function planAll(roots, { github, podspecs, platforms, prepare }, skipped) {
  const plans = new Map()
  await eachConcurrently(roots, async (root) => {
    const where = about(root.name)
    const bytes = root.external === undefined ? await getPodspec(root.name, root.version, root.checksum) : await unlessSkipped(() => localPodspec(root, podspecs, where), root, skipped)
    if (bytes === undefined) return
    const podspec = readPodspec(bytes, root.name, root.version, where)
    const source = unlessSkipped(() => sourceOf(podspec, where, prepare !== undefined), root, skipped)
    if (source === undefined) return
    const command = given(podspec.attributes.prepare_command) ? podspec.attributes.prepare_command : undefined
    if (command !== undefined && typeof command !== 'string') throw new DeptreeError('its prepare_command is not text, which CocoaPods fails on', where)
    const specs = root.pods.map((name) => specNamed(podspec, name) ?? refuse(`its podspec has no ${quote(name)}, which the lockfile installs`, where))
    const files = planPod(podspec, specs, platforms, where)
    if (source.type === 'git') await checkCloned(github, source.repo, source.commit, where)
    plans.set(root.name, { root, files, source, command })
  }, (root) => about(root.name))
  return plans
}

// A download, fetched once for every pod of it: a checkout by its repository and commit, an archive by its
// hash and what RemoteFile makes of it
const downloadOf = ({ source }) => (source.type === 'git' ? `git ${source.repo}@${source.commit}` : `http ${source.sha256} ${source.file} ${source.flatten}`)
async function contentsOf({ root, source }, github) {
  const where = about(root.name)
  if (source.type === 'git') return await checkoutOf(github, source.repo, source.commit, where)
  return await archiveOf(await getPodArchive(source.url, source.sha256), source, where)
}

const PREPARED = 'prepare must give the download back as it is after the command: its dirs, a Map of its files, each with data and a mode, and a Map of its links'

// A copy of the download, with the pod's prepare_command run in it by the caller
async function prepared(prepare, { root, command }, contents) {
  const copy = { dirs: new Set(contents.dirs), files: new Map(contents.files), links: new Map(contents.links) }
  const after = await prepare({ name: root.name, version: root.version, command, contents: copy })
  const isFile = (file) => file !== null && typeof file === 'object' && file.data instanceof Uint8Array && Number.isInteger(file.mode)
  const valid = after !== null && typeof after === 'object' && typeof after.dirs?.[Symbol.iterator] === 'function' && after.files instanceof Map && after.links instanceof Map
    && [...after.dirs, ...after.files.keys(), ...after.links.keys(), ...after.links.values()].every((path) => typeof path === 'string') && [...after.files.values()].every(isFile)
  if (!valid) throw new TypeError(PREPARED)
  return { dirs: new Set(after.dirs), files: after.files, links: after.links }
}

// What CocoaPods keeps of each pod's download, held only while its pods are installed; a prepare_command
// runs in the copy before it is cleaned
async function installAll(plans, github, { prepare, ...options }) {
  const byDownload = Map.groupBy(plans.values(), downloadOf)
  const installed = new Map()
  await eachConcurrently(byDownload.values(), async (group) => {
    const contents = await contentsOf(group[0], github)
    // An archive is no clone, with no .git for CocoaPods to copy.
    const keepsGit = options.keepsGit && group[0].source.type === 'git'
    for (const plan of group) {
      const download = plan.command === undefined ? contents : await prepared(prepare, plan, contents)
      installed.set(plan.root.name, installPod(download, plan.files, { ...options, keepsGit, where: about(plan.root.name) }))
    }
  }, ([{ root }]) => about(root.name))
  return installed
}

function installedOf({ name, version, checksum, pods }, { source }) {
  const pod = { path: `Pods/${name}`, name, version, checksum, pods: [...pods] }
  if (source.type === 'git') return { ...pod, git: source.url, commit: source.commit }
  return { ...pod, http: source.url, sha256: source.sha256 }
}

// Pods/Manifest.lock, as CocoaPods writes Podfile.lock: the reader holds the lockfile to be that, so it is
// the lockfile's UTF-8
function writeManifest(vfs, lockfile, stats) {
  const data = utf8fromString(lockfile)
  makeDirs(vfs, 'Pods')
  vfs.writeFile('/Pods/Manifest.lock', data)
  stats.files++
  stats.bytes += data.length
}

export async function buildCocoaPodsTree(options) {
  const all = options ?? {}
  const { vfs: into, github } = all
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  if (github !== undefined && GITHUB_METHODS.some((name) => typeof github?.[name] !== 'function')) throw new TypeError(GITHUB)
  const inputs = inputsOf(all)
  const platforms = platformsOf(all.platforms)
  const { manifest, partial } = flagsOf(all)
  const only = onlyOf(all.only)
  const host = checkHost(all.host)
  const folded = host.os === 'darwin'
  // 1.13 to 1.15 copy a download into the cache with FileUtils.cp_r, which copies .git; 1.16 on, rsync
  const keepsGit = Number(host.cocoapods.split('.')[1]) < 16
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoPods(into, folded)
  const lock = await parsePodfileLock(inputs.lockfile, inputs.podfile === undefined ? {} : { podfile: inputs.podfile })
  const roots = Object.values(lock.roots)
  const unknown = [...(only ?? [])].find((name) => !roots.some((root) => root.name === name))
  if (unknown !== undefined) throw new DeptreeError('the lockfile has no pod of the name, which `only` has', about(unknown))
  const skipped = partial ? new Map() : undefined
  // A pod `only` leaves out is not looked at: not refused, skipped or fetched.
  const fetched = roots.filter((root) => only?.has(root.name) !== false && unlessSkipped(() => isDownloaded(root, folded), root, skipped))
  if (github === undefined && fetched.length > 0) throw new TypeError(GITHUB)
  const { prepare } = all
  if (prepare !== undefined && typeof prepare !== 'function') throw new TypeError('prepare must be a function that runs a prepare_command, or left out')
  const plans = await planAll(fetched, { github, podspecs: inputs.podspecs, platforms, prepare }, skipped)
  const contents = await installAll(plans, github, { folded, keepsGit, prepare })
  // In the lockfile's order, whatever order the fetches finished in.
  const downloaded = fetched.filter(({ name }) => plans.has(name))
  const vfs = new Vfs()
  const stats = { pods: roots.length, downloaded: downloaded.length, files: 0, bytes: 0, links: 0 }
  if (downloaded.length > 0) makeDirs(vfs, 'Pods')
  for (const { name } of downloaded) writeFiles(vfs, `Pods/${name}`, contents.get(name), stats)
  if (manifest) writeManifest(vfs, inputs.lockfile, stats)
  const installed = downloaded.map((root) => installedOf(root, plans.get(root.name)))
  const left = roots.filter(({ name }) => skipped?.has(name)).map(({ name, version }) => ({ name, version, reason: skipped.get(name) }))
  return { vfs: mount(vfs, into, folded, checkNoPods), stats, installed, skipped: left }
}
