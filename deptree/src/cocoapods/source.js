// Where a pod is downloaded from: its podspec's `source`, as cocoapods-downloader takes it

import { isPodArchiveUrl } from '@preventive/upstream/cocoapods.js'
import { DeptreeError, quote } from '../error.js'
import { githubRepoOf } from '../github.js'
import { given, isObject } from './podspec.js'

// cocoapods-downloader's strategies; a source names one of them alone.
const STRATEGIES = ['git', 'hg', 'http', 'scp', 'svn']
// What its Git takes beside the URL; anything else it refuses.
const GIT_OPTIONS = new Set(['git', 'tag', 'commit', 'branch', 'submodules'])
const COMMIT = /^[\da-f]{40}$/u
// What its Http, a RemoteFile, takes beside the URL; anything else it refuses
const HTTP_OPTIONS = new Set(['http', 'type', 'flatten', 'sha1', 'sha256', 'headers'])
// RemoteFile compares :sha256 before :sha1, as text, to the lowercase hex Ruby's hexdigest writes; a sha256
// alone is taken, as two archives can be made to share a sha1
const SHA256 = /^[\da-f]{64}$/u
// RemoteFile's types, by :type or the end of the URL's path: tars `tar xf` extracts and are flattened by
// default, a zip `unzip` extracts, and a dmg it mounts, not read here
const TARS = new Set(['tgz', 'tar', 'tbz', 'txz'])
const TYPES = new Set([...TARS, 'zip', 'dmg'])
const URL_TYPES = [[/\.zip$/u, 'zip'], [/\.(?:tgz|tar\.gz)$/u, 'tgz'], [/\.tar$/u, 'tar'], [/\.(?:tbz|tar\.bz2)$/u, 'tbz'], [/\.(?:txz|tar\.xz)$/u, 'txz'], [/\.dmg$/u, 'dmg']]
// Meta's namespace on Maven Central, under which isPodArchiveUrl takes a .tar.gz or a .zip
const MAVEN_FACEBOOK = 'https://repo1.maven.org/maven2/com/facebook/'

// A refusal of where a pod is downloaded from, for which `partial` leaves the pod to CocoaPods
export class SourceRefusal extends DeptreeError {}

// Git from a GitHub repository by a full commit, or :http (httpSourceOf), else a SourceRefusal: a tag, as
// GitHub can move one; a prepare_command unless `prepares`, where the caller runs it; any other source
export function sourceOf(podspec, where, prepares = false) {
  if (given(podspec.attributes.prepare_command) && !prepares) throw new SourceRefusal('a prepare_command, a script CocoaPods runs in the download, is not supported', where)
  const source = podspec.attributes.source
  if (!isObject(source)) throw new SourceRefusal('its podspec has no source to download it from', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new SourceRefusal('its podspec\'s source names no one way to download it, which CocoaPods fails on', where)
  if (strategies[0] === 'http') return httpSourceOf(source, where)
  if (strategies[0] !== 'git') throw new SourceRefusal(`a source by :${strategies[0]} is not supported: only git from GitHub, and :http from GitHub or Maven Central's com/facebook/, are`, where)
  const other = Object.keys(source).find((key) => !GIT_OPTIONS.has(key))
  if (other !== undefined) throw new SourceRefusal(`its source has :${other}, which cocoapods-downloader refuses of git`, where)
  const { git: url, tag, commit, branch, submodules } = source
  const repo = typeof url === 'string' ? githubRepoOf(url) : undefined
  if (repo === undefined) throw new SourceRefusal(`a git source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not a GitHub repository over https or ssh, is not supported`, where)
  if (given(submodules)) throw new SourceRefusal('a git source with its submodules is not supported: GitHub\'s tarball leaves each empty', where)
  if (given(branch)) throw new SourceRefusal('a git source by a branch, which locks no commit, is not supported', where)
  // CocoaPods records no commit for a tag, which GitHub can move.
  if (given(tag)) throw new SourceRefusal('a git source by a tag, for which neither the lockfile nor the podspec holds a commit, is not supported: only one by a full commit is', where)
  if (!(typeof commit === 'string' && COMMIT.test(commit))) throw new SourceRefusal(given(commit) ? `${quote(String(commit))} is not a full commit, as is supported` : 'a git source by no commit is not supported', where)
  return { type: 'git', url, repo, commit }
}

// An archive getPodArchive fetches, of the type RemoteFile takes it to be and so downloads as
// `file.<type>`, flattened by :flatten as Ruby reads it or else as a tar is, held to its sha256. No hash, a
// sha1 alone, or :headers, which curl would send, is refused.
function httpSourceOf(source, where) {
  const other = Object.keys(source).find((key) => !HTTP_OPTIONS.has(key))
  if (other !== undefined) throw new SourceRefusal(`its source has :${other}, which cocoapods-downloader refuses of :http`, where)
  const { http: url, type: named, flatten, headers } = source
  if (!isPodArchiveUrl(url)) throw new SourceRefusal(`an :http source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not https://github.com/<owner>/<repo>/ and a path under it, or ${MAVEN_FACEBOOK} and one under it to a .tar.gz or a .zip, as the URL parser writes it back out and of letters, digits and \`_.~@-%\`, is not supported`, where)
  if (given(headers)) throw new SourceRefusal('an :http source with :headers, which curl sends with the request, is not supported', where)
  // isPodArchiveUrl's URL ends with its path, which RemoteFile reads a type off.
  const byUrl = URL_TYPES.find(([pattern]) => pattern.test(url))?.[1]
  if (url.startsWith(MAVEN_FACEBOOK) && given(named) && named !== byUrl) throw new SourceRefusal(`its :type ${quote(String(named))} is not the ${byUrl} its URL on Maven Central names, as only a .tar.gz and a .zip from there are supported`, where)
  const type = given(named) ? named : byUrl
  if (typeof type !== 'string' || !TYPES.has(type)) throw new SourceRefusal(`${given(named) ? `its :type ${quote(String(named))}` : 'its URL'} names no type of archive cocoapods-downloader extracts`, where)
  if (type === 'dmg') throw new SourceRefusal('an :http source of a dmg, which hdiutil mounts, is not supported: only a zip, and tgz, tar, tbz and txz, which `tar xf` extracts, are', where)
  if (!given(source.sha256)) throw new SourceRefusal(given(source.sha1) ? 'an :http source held to a :sha1 alone, which two archives can be made to share, is not supported: only one held to a :sha256 is' : 'an :http source with no :sha256 to hold the download to is not supported', where)
  const { sha256 } = source
  if (!(typeof sha256 === 'string' && SHA256.test(sha256))) throw new SourceRefusal('its :sha256 is not one in lowercase hex, which no download matches', where)
  return { type: 'http', url, archive: type, file: `file.${type}`, flatten: Object.hasOwn(source, 'flatten') ? given(flatten) : TARS.has(type), sha256 }
}
