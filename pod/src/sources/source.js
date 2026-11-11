// Where a pod is downloaded from: its podspec's `source` as cocoapods-downloader takes it, held to what is fetched
// alike: git from GitHub by a full commit, or an :http archive on GitHub held to its sha256.

import { PodError, quote } from '../error.js'
import { githubRepoOf } from './github.js'
import { given, isObject } from './podspec.js'

// cocoapods-downloader's strategies; a source names one of them alone.
const STRATEGIES = ['git', 'hg', 'http', 'scp', 'svn']
// What its Git takes beside the URL; anything else it refuses.
const GIT_OPTIONS = new Set(['git', 'tag', 'commit', 'branch', 'submodules'])
const COMMIT = /^[\da-f]{40}$/u
// What its Http, a RemoteFile, takes beside the URL; anything else it
// refuses.
const HTTP_OPTIONS = new Set(['http', 'type', 'flatten', 'sha1', 'sha256', 'headers'])
// The hash RemoteFile checks a download against, :sha256 before :sha1, by
// the lowercase hex Ruby's hexdigest writes, which it compares as text: a
// sha256 alone is taken, as two archives can be made to share a sha1.
const SHA256 = /^[\da-f]{64}$/u
// RemoteFile's types, by :type or the end of the URL's path: tars it
// extracts with `tar xf` and flattens by default, a zip with `unzip`, which
// it does not flatten, and a dmg it mounts, not read here.
const TARS = new Set(['tgz', 'tar', 'tbz', 'txz'])
const TYPES = new Set([...TARS, 'zip', 'dmg'])
const URL_TYPES = [[/\.zip$/u, 'zip'], [/\.(?:tgz|tar\.gz)$/u, 'tgz'], [/\.tar$/u, 'tar'], [/\.(?:tbz|tar\.bz2)$/u, 'tbz'], [/\.(?:txz|tar\.xz)$/u, 'txz'], [/\.dmg$/u, 'dmg']]
// https://github.com/<owner>/<repo>/ and a path under it, as upstream's
// getPodArchive fetches one: no query, fragment, credentials or port, and
// each segment as its buildUrl lets one through.
const LOGIN = /^(?=.{1,39}$)[a-z\d](?:-?[a-z\d])*$/iu
const REPO_NAME = /^(?!\.\.?$)[\w.-]{1,100}$/u
const SEGMENT = /^(?!\.\.?$)(?:[\w.~@-]|%[\dA-F]{2})+$/u
function isGitHubUrl(url) {
  const parsed = URL.parse(url)
  if (parsed?.href !== url || parsed.origin !== 'https://github.com' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return false
  const segments = parsed.pathname.slice(1).split('/')
  return segments.length >= 3 && LOGIN.test(segments[0]) && REPO_NAME.test(segments[1]) && segments.every((segment) => SEGMENT.test(segment))
}

// The podspec's source: a GitHub repository by its URL and a full commit; or an archive on GitHub over https held
// to a hash. A tag is refused, as the lockfile holds no commit for one and GitHub can move it; so is any other.
export function sourceOf(podspec, where) {
  const source = podspec.attributes.source
  if (!isObject(source)) throw new PodError('its podspec has no source to download it from', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new PodError('its podspec\'s source names no one way to download it, which CocoaPods fails on', where)
  if (strategies[0] === 'http') return httpSourceOf(source, where)
  if (strategies[0] !== 'git') throw new PodError(`a source by :${strategies[0]} is not supported: only git from GitHub, and :http from GitHub, are`, where)
  const other = Object.keys(source).find((key) => !GIT_OPTIONS.has(key))
  if (other !== undefined) throw new PodError(`its source has :${other}, which cocoapods-downloader refuses of git`, where)
  const { git: url, tag, commit, branch, submodules } = source
  const repo = typeof url === 'string' ? githubRepoOf(url) : undefined
  if (repo === undefined) throw new PodError(`a git source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not a GitHub repository over https or ssh, is not supported`, where)
  if (given(submodules)) throw new PodError('a git source with its submodules is not supported: GitHub\'s tarball leaves each empty', where)
  if (given(branch)) throw new PodError('a git source by a branch, which locks no commit, is not supported', where)
  // CocoaPods records no commit for a tag, which GitHub can move.
  if (given(tag)) throw new PodError('a git source by a tag, for which neither the lockfile nor the podspec holds a commit, is not supported: only one by a full commit is', where)
  if (!(typeof commit === 'string' && COMMIT.test(commit))) throw new PodError(given(commit) ? `${quote(String(commit))} is not a full commit, as is supported` : 'a git source by no commit is not supported', where)
  return { type: 'git', url, repo, commit }
}

// An :http source: its URL; its type, and so the name RemoteFile downloads it under; whether it is flattened, by
// :flatten or else for a tar alone; and its sha256. One held to no hash, or a sha1 alone, or with :headers, is refused.
function httpSourceOf(source, where) {
  const other = Object.keys(source).find((key) => !HTTP_OPTIONS.has(key))
  if (other !== undefined) throw new PodError(`its source has :${other}, which cocoapods-downloader refuses of :http`, where)
  const { http: url, type: named, flatten, headers } = source
  if (typeof url !== 'string' || !isGitHubUrl(url)) throw new PodError(`an :http source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not https://github.com/<owner>/<repo>/ and a path of letters, digits and \`_.~@-%\` under it, is not supported`, where)
  if (given(headers)) throw new PodError('an :http source with :headers, which curl sends with the request, is not supported', where)
  const type = given(named) ? named : URL_TYPES.find(([pattern]) => pattern.test(URL.parse(url).pathname))?.[1]
  if (typeof type !== 'string' || !TYPES.has(type)) throw new PodError(`${given(named) ? `its :type ${quote(String(named))}` : 'its URL'} names no type of archive cocoapods-downloader extracts`, where)
  if (type === 'dmg') throw new PodError('an :http source of a dmg, which hdiutil mounts, is not supported: only a zip, and tgz, tar, tbz and txz, which `tar xf` extracts, are', where)
  if (!given(source.sha256)) throw new PodError(given(source.sha1) ? 'an :http source held to a :sha1 alone, which two archives can be made to share, is not supported: only one held to a :sha256 is' : 'an :http source with no :sha256 to hold the download to is not supported', where)
  const { sha256 } = source
  if (!(typeof sha256 === 'string' && SHA256.test(sha256))) throw new PodError('its :sha256 is not one in lowercase hex, which no download matches', where)
  return { type: 'http', url, archive: type, file: `file.${type}`, flatten: Object.hasOwn(source, 'flatten') ? given(flatten) : TARS.has(type), sha256 }
}
