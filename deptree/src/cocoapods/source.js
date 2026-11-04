// Where a pod from trunk is downloaded from: its podspec's `source`, as
// cocoapods-downloader takes it, held to what is fetched here alike.

import { DeptreeError, quote } from '../error.js'
import { githubRepoOf } from '../github.js'

// cocoapods-downloader's strategies; a source names one of them alone.
const STRATEGIES = ['git', 'hg', 'http', 'scp', 'svn']
// What its Git takes beside the URL; anything else it refuses.
const GIT_OPTIONS = new Set(['git', 'tag', 'commit', 'branch', 'submodules'])
const COMMIT = /^[\da-f]{40}$/u

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const given = (value) => value !== undefined && value !== null && value !== false

// A refusal of where a pod is downloaded from, which buildCocoaPodsTree's
// `partial` leaves the pod to CocoaPods for; a DeptreeError otherwise.
export class SourceRefusal extends DeptreeError {}

// The podspec's git source: a GitHub repository, by its URL, and the tag
// or the full commit to check out of it. A prepare_command, a script
// CocoaPods runs in the download, is refused, as is any other source,
// each with a SourceRefusal.
export function gitSourceOf(podspec, where) {
  if (given(podspec.attributes.prepare_command)) throw new SourceRefusal('a prepare_command, a script CocoaPods runs in the download, is not supported', where)
  const source = podspec.attributes.source
  if (!isObject(source)) throw new SourceRefusal('its podspec has no source to download it from', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new SourceRefusal('its podspec\'s source names no one way to download it, which CocoaPods fails on', where)
  if (strategies[0] !== 'git') throw new SourceRefusal(`a source by :${strategies[0]} is not supported: only git from GitHub is`, where)
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
  return { url, repo, tag: given(tag) ? tag : undefined, commit: given(commit) ? commit : undefined }
}
