// The pods `pod install` downloads into Pods/ from a Podfile.lock.

import { utf8fromStringLoose } from '@exodus/bytes/utf8.js'
import { parsePodfileLock } from '@preventive/lockfile/cocoapods.js'
import { getPodspec } from '@preventive/upstream/cocoapods.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { checkoutOf, tagCommit } from '../github.js'
import { checkNoDir, fold, makeDirs, mount, writeFiles } from '../mount.js'
import { checkHost, inputsOf, platformsOf } from './inputs.js'
import { installPod } from './install.js'
import { readPodspec, specNamed } from './podspec.js'
import { gitSourceOf } from './source.js'

const GITHUB = 'github must be a GitHub client from createClient, which each pod is fetched through'

// Trunk, as SPEC REPOS names it from CocoaPods 1.8, or the git repository
// trunk's podspecs are kept in, as it named it before; trunk's CDN serves
// the same files.
const isTrunk = (repo) => repo === 'trunk' || /^https:\/\/github\.com\/cocoapods\/specs(?:\.git)?$/iu.test(repo)

// What CocoaPods writes in Pods/ beside the pods, which a pod's directory
// would be one with; and each project of generate_multiple_pod_projects.
const GENERATED = ['Headers', 'Local Podspecs', 'Manifest.lock', 'Pods.xcodeproj', 'Target Support Files']
const PROJECT = '.xcodeproj'

const checkNoPods = checkNoDir('Pods', 'a Pods directory')

const about = (name) => `pods[${quote(name)}]`

// A root CocoaPods downloads into Pods/, true; one by :path, which it
// reads where it is, false; any other, refused.
function isDownloaded(root, folded) {
  const where = about(root.name)
  if (root.external?.type === 'path') return false
  if (root.external !== undefined) throw new DeptreeError(`a pod from an external source by :${root.external.type} is not supported: only those from trunk, and by :path, are`, where)
  if (!isTrunk(root.repo)) throw new DeptreeError(`a pod from the spec repo ${quote(root.repo)} is not supported: only those from trunk are`, where)
  const key = (name) => (folded ? fold(name) : name)
  if (GENERATED.some((name) => key(name) === key(root.name)) || key(root.name).endsWith(key(PROJECT))) {
    throw new DeptreeError('a pod named as what CocoaPods writes beside the pods in Pods/ is not supported', where)
  }
  if (utf8fromStringLoose(root.name).length > 255) throw new DeptreeError('a name too long for a directory, which CocoaPods fails to make', where)
  return true
}

// Each root's podspec, its source and the commit of it, and what of its
// download CocoaPods keeps; a checkout is fetched once for every root
// downloaded from that commit.
async function fetchAll(roots, github, platforms) {
  const installed = new Map()
  const checkouts = new Map()
  await eachConcurrently(roots, async (root) => {
    const where = about(root.name)
    const podspec = readPodspec(await getPodspec(root.name, root.version, root.checksum), root.name, root.version, where)
    const source = gitSourceOf(podspec, where)
    const specs = root.pods.map((name) => {
      const spec = specNamed(podspec, name)
      if (spec === undefined) throw new DeptreeError(`its podspec has no ${quote(name)}, which the lockfile installs`, where)
      return spec
    })
    const commit = source.commit ?? await tagCommit(github, source.repo, source.tag, where)
    const key = `${source.repo}@${commit}`
    if (!checkouts.has(key)) checkouts.set(key, checkoutOf(github, source.repo, commit, where))
    installed.set(root.name, { source, commit, contents: installPod(await checkouts.get(key), podspec, specs, platforms, where) })
  }, (root) => about(root.name))
  return installed
}

export async function buildCocoaPodsTree(options) {
  const { host: given, vfs: into, github, platforms: givenPlatforms } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  if (github !== undefined && ['getRepoTarball', 'getRepoTag', 'getRepoHead', 'getRepo'].some((name) => typeof github?.[name] !== 'function')) throw new TypeError(GITHUB)
  const inputs = inputsOf(options ?? {})
  const platforms = platformsOf(givenPlatforms)
  const folded = checkHost(given).os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoPods(into, folded)
  const lock = parsePodfileLock(inputs.lockfile, inputs.podfile === undefined ? {} : { podfile: inputs.podfile })
  const roots = Object.values(lock.roots)
  const downloaded = roots.filter((root) => isDownloaded(root, folded))
  if (github === undefined && downloaded.length > 0) throw new TypeError(GITHUB)
  const fetched = await fetchAll(downloaded, github, platforms)
  const vfs = new Vfs()
  const stats = { pods: roots.length, downloaded: downloaded.length, files: 0, bytes: 0, links: 0 }
  if (downloaded.length > 0) makeDirs(vfs, 'Pods')
  // In the lockfile's order, whatever order the fetches finished in.
  for (const { name } of downloaded) writeFiles(vfs, `Pods/${name}`, fetched.get(name).contents, stats)
  const installed = downloaded.map(({ name, version, checksum, pods }) => {
    const { source, commit } = fetched.get(name)
    return { path: `Pods/${name}`, name, version, checksum, pods: [...pods], git: source.url, tag: source.tag, commit }
  })
  return { vfs: mount(vfs, into, folded, checkNoPods), stats, installed }
}
