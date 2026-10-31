import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertPod, assertSha1 } from './args.js'
import { verifiedDownload } from './download.js'
import { COCOAPODS_CDN, buildUrl, encodeSegment } from './http.js'

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
