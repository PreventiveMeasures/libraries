// Where a pod is downloaded from: its podspec's `source` as cocoapods-downloader takes it, held to what is fetched
// alike: an :http archive on GitHub, or a .tar.gz or a .zip under Maven Central's com/facebook/, held to its sha256.

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
const OWNER = /^(?=.{1,39}$)[a-z\d](?:-?[a-z\d])*$/iu
const REPO = /^(?!\.\.?$)[\w.-]{1,100}$/u
const SEGMENT = /^(?!\.\.?$)(?:[\w.~@-]|%[\dA-F]{2})+$/u

// https://github.com/<owner>/<repo>/ and a path under it, or a .tar.gz or a .zip under MAVEN_FACEBOOK: as the URL
// parser writes it back out, with nothing but its origin and path, so that the text checked is what is fetched.
function isArchiveUrl(url) {
  const parsed = typeof url === 'string' ? URL.parse(url) : null
  if (parsed?.href !== url || `${parsed.origin}${parsed.pathname}` !== url) return false
  const segments = parsed.pathname.slice(1).split('/')
  if (!segments.every((segment) => SEGMENT.test(segment))) return false
  return (parsed.origin === 'https://github.com' && segments.length >= 3 && OWNER.test(segments[0]) && REPO.test(segments[1])) || (url.startsWith(MAVEN_FACEBOOK) && /\.(?:tar\.gz|zip)$/u.test(url))
}

// An :http source: its URL, as isArchiveUrl takes it; its type, and so the name RemoteFile downloads it
// under; whether it is flattened, by :flatten or else for a tar alone; and its sha256. Any other source is refused.
export function sourceOf(podspec, where) {
  const source = podspec.attributes.source
  if (!isObject(source)) throw new PodError('its podspec has no source', where)
  const strategies = STRATEGIES.filter((strategy) => Object.hasOwn(source, strategy))
  if (strategies.length !== 1) throw new PodError('its source names not exactly one strategy', where)
  if (strategies[0] !== 'http') throw new PodError(`a :${strategies[0]} source is not supported`, where)
  const other = Object.keys(source).find((key) => !HTTP_OPTIONS.has(key))
  if (other !== undefined) throw new PodError(`:${other} is not an :http option`, where)
  const { http: url, type: named, flatten, headers } = source
  if (!isArchiveUrl(url)) throw new PodError(`${quote(String(url))} is not a GitHub URL, or a .tar.gz or .zip under ${MAVEN_FACEBOOK}`, where)
  if (given(headers)) throw new PodError(':headers is not supported', where)
  // isArchiveUrl's URL ends with its path, which RemoteFile reads a type off.
  const byUrl = URL_TYPES.find(([pattern]) => pattern.test(url))?.[1]
  if (url.startsWith(MAVEN_FACEBOOK) && given(named) && named !== byUrl) throw new PodError(`its :type ${quote(String(named))} is not its URL's ${byUrl}`, where)
  const type = given(named) ? named : byUrl
  if (typeof type !== 'string' || !TYPES.has(type)) throw new PodError(`${given(named) ? `its :type ${quote(String(named))}` : 'its URL'} names no archive type`, where)
  if (type === 'dmg') throw new PodError('a dmg is not supported', where)
  if (!given(source.sha256)) throw new PodError(`its source has no :sha256${given(source.sha1) ? ', only a :sha1' : ''}`, where)
  const { sha256 } = source
  if (!(typeof sha256 === 'string' && SHA256.test(sha256))) throw new PodError('its :sha256 is not lowercase hex', where)
  return { url, archive: type, file: `file.${type}`, flatten: Object.hasOwn(source, 'flatten') ? given(flatten) : TARS.has(type), sha256 }
}
