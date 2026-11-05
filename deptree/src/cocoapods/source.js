// Where a pod is downloaded from: its podspec's `source`, as
// cocoapods-downloader takes it, held to what is fetched here alike.

import { DeptreeError, quote } from '../error.js'
import { githubRepoOf } from '../github.js'

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
// RemoteFile's types, as its :type names one, and else by the end of the
// URL's path, type_with_url: those it extracts with `tar xf`, which reads
// an archive by what it is rather than by its name, and flattens by
// default; a zip and a dmg are not read here.
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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const given = (value) => value !== undefined && value !== null && value !== false

// A refusal of where a pod is downloaded from, which buildCocoaPodsTree's
// `partial` leaves the pod to CocoaPods for; a DeptreeError otherwise.
export class SourceRefusal extends DeptreeError {}

// The podspec's source: git, a GitHub repository by its URL and the tag or
// the full commit to check out of it; or :http, an archive on GitHub over
// https, `tar xf` extracts, and the hash the podspec holds it to. A
// prepare_command, a script CocoaPods runs in the download, is refused, as
// is any other source, each with a SourceRefusal.
export function sourceOf(podspec, where) {
  if (given(podspec.attributes.prepare_command)) throw new SourceRefusal('a prepare_command, a script CocoaPods runs in the download, is not supported', where)
  const source = podspec.attributes.source
  if (!isObject(source)) throw new SourceRefusal('its podspec has no source to download it from', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new SourceRefusal('its podspec\'s source names no one way to download it, which CocoaPods fails on', where)
  if (strategies[0] === 'http') return httpSourceOf(source, where)
  if (strategies[0] !== 'git') throw new SourceRefusal(`a source by :${strategies[0]} is not supported: only git from GitHub, and :http from GitHub, are`, where)
  const other = Object.keys(source).find((key) => !GIT_OPTIONS.has(key))
  if (other !== undefined) throw new SourceRefusal(`its source has :${other}, which cocoapods-downloader refuses of git`, where)
  const { git: url, tag, commit, branch, submodules } = source
  const repo = typeof url === 'string' ? githubRepoOf(url) : undefined
  if (repo === undefined) throw new SourceRefusal(`a git source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not a GitHub repository over https or ssh, is not supported`, where)
  if (given(submodules)) throw new SourceRefusal('a git source with its submodules is not supported: GitHub\'s tarball leaves each empty', where)
  if (given(branch)) throw new SourceRefusal('a git source by a branch, which locks no commit, is not supported', where)
  if (given(tag) === given(commit)) throw new SourceRefusal('a git source by a tag or a commit alone is supported, and this one names both or neither', where)
  if (given(commit) && !(typeof commit === 'string' && COMMIT.test(commit))) throw new SourceRefusal(`${quote(String(commit))} is not a full commit, as is supported`, where)
  if (given(tag) && !(typeof tag === 'string' && tag !== '' && !tag.startsWith('--') && !tag.includes(' --'))) throw new SourceRefusal('its tag is not one cocoapods-downloader takes', where)
  return { type: 'git', url, repo, tag: given(tag) ? tag : undefined, commit: given(commit) ? commit : undefined }
}

// An :http source: its URL, on GitHub over https; what RemoteFile takes it
// to be, and so the name it downloads it under, `file.<type>`, in the
// directory it extracts it into; whether it flattens it, by :flatten where
// that is given, as Ruby reads a value, and else by its type; and the
// sha256 it checks it against. A download held to no hash, or to a sha1
// alone, is refused, as is one with :headers, which curl would send.
function httpSourceOf(source, where) {
  const other = Object.keys(source).find((key) => !HTTP_OPTIONS.has(key))
  if (other !== undefined) throw new SourceRefusal(`its source has :${other}, which cocoapods-downloader refuses of :http`, where)
  const { http: url, type: named, flatten, headers } = source
  if (typeof url !== 'string' || !isGitHubUrl(url)) throw new SourceRefusal(`an :http source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not https://github.com/<owner>/<repo>/ and a path of letters, digits and \`_.~@-%\` under it, is not supported`, where)
  if (given(headers)) throw new SourceRefusal('an :http source with :headers, which curl sends with the request, is not supported', where)
  const type = given(named) ? named : URL_TYPES.find(([pattern]) => pattern.test(URL.parse(url).pathname))?.[1]
  if (typeof type !== 'string' || !TYPES.has(type)) throw new SourceRefusal(`${given(named) ? `its :type ${quote(String(named))}` : 'its URL'} names no type of archive cocoapods-downloader extracts`, where)
  if (!TARS.has(type)) throw new SourceRefusal(`an :http source of a ${type} is not supported: only those \`tar xf\` extracts, tgz, tar, tbz and txz, are`, where)
  if (!given(source.sha256)) throw new SourceRefusal(given(source.sha1) ? 'an :http source held to a :sha1 alone, which two archives can be made to share, is not supported: only one held to a :sha256 is' : 'an :http source with no :sha256 to hold the download to is not supported', where)
  const { sha256 } = source
  if (!(typeof sha256 === 'string' && SHA256.test(sha256))) throw new SourceRefusal('its :sha256 is not one in lowercase hex, which no download matches', where)
  return { type: 'http', url, archive: type, file: `file.${type}`, flatten: Object.hasOwn(source, 'flatten') ? given(flatten) : true, sha256 }
}
