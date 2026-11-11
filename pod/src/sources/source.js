// Where a pod is downloaded from: its podspec's `source` as cocoapods-downloader takes it, held to what is fetched
// alike: an :http archive on GitHub, or a .tar.gz or a .zip under Maven Central's com/facebook/, held to its sha256.

import { isPodArchiveUrl } from '@preventive/upstream/cocoapods.js'

import { PodError, quote } from '../error.js'
import { given, isObject } from './podspec.js'

// cocoapods-downloader's strategies; a source names one of them alone.
const STRATEGIES = ['git', 'hg', 'http', 'scp', 'svn']
// What its Http, a RemoteFile, takes beside the URL; anything else it refuses.
const HTTP_OPTIONS = new Set(['http', 'type', 'flatten', 'sha1', 'sha256', 'headers'])
// RemoteFile checks a :sha256 before a :sha1, in lowercase hex, compared as text; a sha1 alone is refused, as two
// archives can be made to share one.
const SHA256 = /^[\da-f]{64}$/u
// RemoteFile's types, by :type or the end of the URL's path: tars it extracts with `tar xf` and flattens by
// default, a zip with `unzip`, and a dmg it mounts, not read here.
const TARS = new Set(['tgz', 'tar', 'tbz', 'txz'])
const TYPES = new Set([...TARS, 'zip', 'dmg'])
const URL_TYPES = [[/\.zip$/u, 'zip'], [/\.(?:tgz|tar\.gz)$/u, 'tgz'], [/\.tar$/u, 'tar'], [/\.(?:tbz|tar\.bz2)$/u, 'tbz'], [/\.(?:txz|tar\.xz)$/u, 'txz'], [/\.dmg$/u, 'dmg']]
// Meta's namespace on Maven Central, where React Native publishes its iOS archives.
const MAVEN_FACEBOOK = 'https://repo1.maven.org/maven2/com/facebook/'

// An :http source: its URL, one upstream's getPodArchive fetches; its type, and so the name RemoteFile downloads it
// under; whether it is flattened, by :flatten or else for a tar alone; and its sha256. Any other source is refused.
export function sourceOf(podspec, where) {
  const source = podspec.attributes.source
  if (!isObject(source)) throw new PodError('its podspec has no source to download it from', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new PodError('its podspec\'s source names no one way to download it, which CocoaPods fails on', where)
  if (strategies[0] !== 'http') throw new PodError(`a source by :${strategies[0]} is not supported: only :http from GitHub or Maven Central's com/facebook/, held to its :sha256, is`, where)
  const other = Object.keys(source).find((key) => !HTTP_OPTIONS.has(key))
  if (other !== undefined) throw new PodError(`its source has :${other}, which cocoapods-downloader refuses of :http`, where)
  const { http: url, type: named, flatten, headers } = source
  if (!isPodArchiveUrl(url)) throw new PodError(`an :http source from ${typeof url === 'string' ? quote(url) : 'nowhere'}, not https://github.com/<owner>/<repo>/ and a path under it, or ${MAVEN_FACEBOOK} and one under it to a .tar.gz or a .zip, as the URL parser writes it back out and of letters, digits and \`_.~@-%\`, is not supported`, where)
  if (given(headers)) throw new PodError('an :http source with :headers, which curl sends with the request, is not supported', where)
  // isPodArchiveUrl's URL ends with its path, which RemoteFile reads a type off.
  const byUrl = URL_TYPES.find(([pattern]) => pattern.test(url))?.[1]
  if (url.startsWith(MAVEN_FACEBOOK) && given(named) && named !== byUrl) throw new PodError(`its :type ${quote(String(named))} is not the ${byUrl} its URL on Maven Central names, as only a .tar.gz and a .zip from there are supported`, where)
  const type = given(named) ? named : byUrl
  if (typeof type !== 'string' || !TYPES.has(type)) throw new PodError(`${given(named) ? `its :type ${quote(String(named))}` : 'its URL'} names no type of archive cocoapods-downloader extracts`, where)
  if (type === 'dmg') throw new PodError('an :http source of a dmg, which hdiutil mounts, is not supported: only a zip, and tgz, tar, tbz and txz, which `tar xf` extracts, are', where)
  if (!given(source.sha256)) throw new PodError(given(source.sha1) ? 'an :http source held to a :sha1 alone, which two archives can be made to share, is not supported: only one held to a :sha256 is' : 'an :http source with no :sha256 to hold the download to is not supported', where)
  const { sha256 } = source
  if (!(typeof sha256 === 'string' && SHA256.test(sha256))) throw new PodError('its :sha256 is not one in lowercase hex, which no download matches', where)
  return { url, archive: type, file: `file.${type}`, flatten: Object.hasOwn(source, 'flatten') ? given(flatten) : TARS.has(type), sha256 }
}
