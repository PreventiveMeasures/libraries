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
import { checkHost, flagsOf, inputsOf, platformsOf } from './inputs.js'
import { installPod, planPod } from './install.js'
import { readPodspec, specNamed } from './podspec.js'
import { SourceRefusal, sourceOf } from './source.js'

const GITHUB = 'github must be a GitHub client from createClient, which each pod is fetched through'
const GITHUB_METHODS = ['getRepo', 'compareCommits', 'getCommitTree', 'getRepoTreeTarball']

// Trunk, as SPEC REPOS names it from CocoaPods 1.8, or the git repository
// trunk's podspecs are kept in, as it named it before; trunk's CDN serves
// the same files.
const isTrunk = (repo) => repo === 'trunk' || /^https:\/\/github\.com\/cocoapods\/specs(?:\.git)?$/iu.test(repo)

// What CocoaPods writes in Pods/ beside the pods, which a pod's directory
// would be one with: Pods.xcodeproj among the projects of
// generate_multiple_pod_projects, each `<name>.xcodeproj`.
const GENERATED = ['Headers', 'Local Podspecs', 'Manifest.lock', 'Target Support Files']
const isGenerated = (name, key) => GENERATED.some((other) => key(other) === key(name)) || key(name).endsWith(key('.xcodeproj'))

const checkNoPods = checkNoDir('Pods', 'a Pods directory')

const about = (name) => `pods[${quote(name)}]`

// A root CocoaPods downloads into Pods/, true: one from trunk, or by
// :podspec, which CocoaPods downloads by its podspec's source, but where
// it resolved that to a commit, CHECKOUT OPTIONS', which it downloads by
// those. One by :path, which it reads where it is, false; any other,
// refused.
function isDownloaded(root, folded) {
  const where = about(root.name)
  if (root.external?.type === 'path') return false
  if (root.external?.type === 'podspec' && root.checkout !== undefined) throw new SourceRefusal('a pod by :podspec that CocoaPods downloads by its CHECKOUT OPTIONS is not supported', where)
  if (root.external !== undefined && root.external.type !== 'podspec') throw new SourceRefusal(`a pod from an external source by :${root.external.type} is not supported: only those from trunk, by :podspec and by :path are`, where)
  if (root.external === undefined && !isTrunk(root.repo)) throw new SourceRefusal(`a pod from the spec repo ${quote(root.repo)} is not supported: only those from trunk are`, where)
  if (isGenerated(root.name, folded ? fold : (name) => name)) throw new DeptreeError('a pod named as what CocoaPods writes beside the pods in Pods/ is not supported', where)
  // PodDirCleaner globs the pod's directory by its path as it is, which
  // then matches what it should not, or nothing.
  if (/[*?[\]{}]/u.test(root.name)) throw new DeptreeError('a name with a glob\'s `*`, `?`, `[`, `]`, `{` or `}` in it, which CocoaPods cleans the pod by, is not supported', where)
  // ASCII, as the lockfile reader holds a pod's name to.
  if (root.name.length > 255) throw new DeptreeError('a name too long for a directory, which CocoaPods fails to make', where)
  return true
}

function refuse(detail, where) {
  throw new DeptreeError(detail, where)
}

// What `attempt` gives, or comes to where it is async, or with `partial`,
// where it refuses where the pod is downloaded from, undefined, its refusal
// kept in `skipped` by the pod's name; any other refusal stands.
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

// The podspec of a pod by :podspec, as CocoaPods wrote it in Pods/Local
// Podspecs, held to the lockfile's checksum, which is its sha1.
async function localPodspec(root, podspecs, where) {
  const bytes = podspecs(root.name)
  if (bytes === undefined) throw new SourceRefusal(`its podspec, the JSON CocoaPods writes as Pods/Local Podspecs/${root.name}.podspec.json, is not given`, where)
  const sum = await sha1Hex(bytes)
  if (sum !== root.checksum) throw new DeptreeError(`its podspec given is not the one the lockfile has the checksum of: its sha1 is ${sum}, not ${root.checksum}`, where)
  return bytes
}

// Each root's podspec, its source, and what of its download it keeps,
// planPod's, all before any download, so that a pod refused fails the call
// before any tarball or archive is fetched. A pod skipped for its source
// has no plan, its podspec held to the lockfile all the same.
async function planAll(roots, { github, podspecs, platforms }, skipped) {
  const plans = new Map()
  await eachConcurrently(roots, async (root) => {
    const where = about(root.name)
    const bytes = root.external === undefined ? await getPodspec(root.name, root.version, root.checksum) : await unlessSkipped(() => localPodspec(root, podspecs, where), root, skipped)
    if (bytes === undefined) return
    const podspec = readPodspec(bytes, root.name, root.version, where)
    const source = unlessSkipped(() => sourceOf(podspec, where), root, skipped)
    if (source === undefined) return
    const specs = root.pods.map((name) => specNamed(podspec, name) ?? refuse(`its podspec has no ${quote(name)}, which the lockfile installs`, where))
    const files = planPod(podspec, specs, platforms, where)
    if (source.type === 'git') await checkCloned(github, source.repo, source.commit, where)
    plans.set(root.name, { root, files, source })
  }, (root) => about(root.name))
  return plans
}

// What a download comes to, each fetched once, for every pod of it: a
// checkout, by its repository and commit; an archive, by its hash and what
// RemoteFile makes of it.
const downloadOf = ({ source }) => (source.type === 'git' ? `git ${source.repo}@${source.commit}` : `http ${source.sha256} ${source.file} ${source.flatten}`)
async function contentsOf({ root, source }, github) {
  const where = about(root.name)
  if (source.type === 'git') return await checkoutOf(github, source.repo, source.commit, where)
  return await archiveOf(await getPodArchive(source.url, source.sha256), source, where)
}

// What CocoaPods keeps of each pod's download, held only while the pods of
// it are installed.
async function installAll(plans, github, options) {
  const byDownload = Map.groupBy(plans.values(), downloadOf)
  const installed = new Map()
  await eachConcurrently(byDownload.values(), async (group) => {
    const contents = await contentsOf(group[0], github)
    // An archive is no clone, with no .git for CocoaPods to copy.
    const keepsGit = options.keepsGit && group[0].source.type === 'git'
    for (const plan of group) installed.set(plan.root.name, installPod(contents, plan.files, { ...options, keepsGit, where: about(plan.root.name) }))
  }, ([{ root }]) => about(root.name))
  return installed
}

// A pod written, as CocoaPodsInstalled has it: from git, by the commit
// checked out; by :http, by the URL and the sha256 it is held to.
function installedOf({ name, version, checksum, pods }, { source }) {
  const pod = { path: `Pods/${name}`, name, version, checksum, pods: [...pods] }
  if (source.type === 'git') return { ...pod, git: source.url, commit: source.commit }
  return { ...pod, http: source.url, sha256: source.sha256 }
}

// Pods/Manifest.lock, which CocoaPods writes as it writes Podfile.lock;
// the lockfile reader holds the lockfile to be as CocoaPods writes it, so
// it is the lockfile's bytes: its text as UTF-8, of no lone surrogate, as
// the reader refuses one.
function writeManifest(vfs, lockfile, stats) {
  const data = utf8fromString(lockfile)
  makeDirs(vfs, 'Pods')
  vfs.writeFile('/Pods/Manifest.lock', data)
  stats.files++
  stats.bytes += data.length
}

export async function buildCocoaPodsTree(options) {
  const { host: given, vfs: into, github, platforms: givenPlatforms } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  if (github !== undefined && GITHUB_METHODS.some((name) => typeof github?.[name] !== 'function')) throw new TypeError(GITHUB)
  const inputs = inputsOf(options ?? {})
  const platforms = platformsOf(givenPlatforms)
  const { manifest, partial } = flagsOf(options ?? {})
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  // 1.13 to 1.15 copy a download into their cache with FileUtils.cp_r,
  // which copies the clone's .git; 1.16 on, with rsync, which leaves it out.
  const keepsGit = Number(host.cocoapods.split('.')[1]) < 16
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoPods(into, folded)
  const lock = await parsePodfileLock(inputs.lockfile, inputs.podfile === undefined ? {} : { podfile: inputs.podfile })
  const roots = Object.values(lock.roots)
  const skipped = partial ? new Map() : undefined
  const fetched = roots.filter((root) => unlessSkipped(() => isDownloaded(root, folded), root, skipped))
  if (github === undefined && fetched.length > 0) throw new TypeError(GITHUB)
  const plans = await planAll(fetched, { github, podspecs: inputs.podspecs, platforms }, skipped)
  const contents = await installAll(plans, github, { folded, keepsGit })
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
