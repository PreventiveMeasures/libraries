import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertPod, assertSha1, assertSha256, assertion, isRepo } from './args.js'
import { verifiedDownload } from './download.js'
import { COCOAPODS_CDN, GITHUB_WEB, buildUrl, encodeSegment } from './http.js'

// No expiry, but kept by checksum as well: trunk refuses a version it
// already has, yet rewrites a podspec it has, as `pod trunk deprecate`
// adds a field to the latest version's.
const DIR = 'cocoapods/podspecs'

// Where a spec repo keeps a version's podspec: under a directory each for
// the first three hex digits of the md5 of the name, as
// Pod::Source::Metadata shards trunk, and CocoaPods/Specs with it.
function specPath(name, version) {
  const shard = createHash('md5').update(name).digest('hex').slice(0, 3)
  return ['Specs', ...shard, name, version, `${name}.podspec.json`]
}

// CocoaPods' spec repos, a directory each under $CP_REPOS_DIR, else
// $CP_HOME_DIR/repos, else ~/.cocoapods/repos: `trunk` with the podspecs
// it read off the CDN as they were served, `master` a clone of
// CocoaPods/Specs, others a team's own. os.homedir() throws where there is
// no home directory to be found.
async function localPaths(name, version) {
  const { CP_REPOS_DIR, CP_HOME_DIR } = process.env
  let root
  try {
    root = resolve(CP_REPOS_DIR || join(CP_HOME_DIR || join(homedir(), '.cocoapods'), 'repos'))
  } catch {
    return []
  }
  return (await readdir(root).catch(() => [])).map((repo) => join(root, repo, ...specPath(name, version)))
}

// Where pod archives are kept: by their hash alone, which names them.
const ARCHIVES = 'cocoapods/archives'

// https://github.com/<owner>/<repo>/ and a path under it, as buildUrl
// would write it: no query, fragment, credentials or port, and nothing in
// a segment but what it lets through.
function isGitHubUrl(value) {
  const parsed = typeof value === 'string' ? URL.parse(value) : null
  if (parsed?.origin !== GITHUB_WEB) return false
  const segments = parsed.pathname.slice(1).split('/')
  if (segments.length < 3 || !isRepo(`${segments[0]}/${segments[1]}`)) return false
  try {
    return buildUrl(GITHUB_WEB, segments) === value
  } catch {
    return false
  }
}
const assertGitHubUrl = assertion('an https URL of a GitHub repository\'s, with a path under it', isGitHubUrl)
const HASHES = { sha256: assertSha256, sha1: assertSha1 }

// An archive a podspec's source names by :http, held to the hash the
// podspec gives of it. GitHub's answer for a tag's archive or a release's
// asset is a redirect, to codeload.github.com or to where it keeps the
// files, which is followed: the bytes are held to the hash whoever answers.
export async function getPodArchive(url, algorithm, digest) {
  assertGitHubUrl('getPodArchive', 'url', url)
  assertion('sha256 or sha1', (value) => Object.hasOwn(HASHES, value))('getPodArchive', 'algorithm', algorithm)
  HASHES[algorithm]('getPodArchive', 'digest', digest)
  return await verifiedDownload({
    method: 'getPodArchive', dir: ARCHIVES, what: url, entry: `${algorithm}-${digest}`, ext: 'archive', algorithm, expected: digest,
    locate: () => url, options: { redirect: 'follow' },
  })
}

// Trunk has no hash to check a podspec against, so the caller brings one,
// as Podfile.lock records it. The CDN redirects to jsDelivr, which is
// followed: whoever answers, the bytes are held to the checksum.
export async function getPodspec(name, version, checksum) {
  assertPod('getPodspec', name, version)
  assertSha1('getPodspec', 'checksum', checksum)
  const what = `${name}@${version}`
  const locate = () => buildUrl(COCOAPODS_CDN, specPath(name, version).map(encodeSegment))
  return await verifiedDownload({
    method: 'getPodspec', dir: DIR, what, entry: `${what}-${checksum}`, ext: 'podspec.json', algorithm: 'sha1', expected: checksum,
    local: await localPaths(name, version), locate, options: { redirect: 'follow' },
  })
}
