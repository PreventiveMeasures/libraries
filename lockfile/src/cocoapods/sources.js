// What a Podfile names a pod's external source by, as EXTERNAL SOURCES has
// it, and what CocoaPods would download it again by, as CHECKOUT OPTIONS
// has it: options by symbol, as the Podfile gives them to `pod`, which
// CocoaPods reads by ExternalSources.from_params and cocoapods-downloader.
// A `:podspec` comes first, then a `:path`, then one way to download;
// anything else beside a `:podspec` or a `:path` CocoaPods carries along,
// and passes over, and it is handed back as `options`.

import { LockfileError, quote } from '../error.js'
import { checkHttpUrl, checkRefName, checkRepo, isHexSha1, isHexSha256 } from '../names.js'
import { entriesOf, itemsOf, scalarOf, textOf } from './shape.js'

// cocoapods-downloader's strategies, each with the options it takes, and
// the field each is handed back as.
const FILE = ['type', 'flatten', 'sha1', 'sha256', 'headers']
export const DOWNLOADS = {
  __proto__: null,
  git: ['commit', 'tag', 'branch', 'submodules'],
  hg: ['revision', 'tag', 'branch'],
  http: FILE,
  scp: FILE,
  svn: ['revision', 'tag', 'folder', 'externals', 'checkout'],
}
export const fieldOf = (option) => (option === 'type' ? 'fileType' : option)

const BOOLEANS = new Set(['submodules', 'flatten', 'externals', 'checkout'])
// What RemoteFile extracts, by `:type`.
const FILE_TYPES = new Set(['zip', 'tgz', 'tar', 'tbz', 'txz', 'dmg'])
// In lowercase hex: a commit, which git takes short, and a file's digests.
const HEX = { __proto__: null, commit: (value) => /^[\da-f]{4,64}$/u.test(value), sha1: isHexSha1, sha256: isHexSha256 }

// A path from the Podfile's directory, as the Podfile has it: CocoaPods
// takes `./`, `..` and a `/` at the end as they are. It takes an absolute
// path and one from home too, which are refused, as each reads on the
// machine that wrote it alone; and so is a backslash, or an empty segment.
function checkPath(path, where) {
  if (/^(?:\/|[A-Za-z]:)/u.test(path)) throw new LockfileError(`${quote(path)} is absolute, and only reads on the machine that wrote it`, where)
  if (path.startsWith('~')) throw new LockfileError(`${quote(path)} is from a home directory, and only reads on the machine that wrote it`, where)
  if (path.includes('\\') || path.includes('//')) throw new LockfileError(`${quote(path)} is not a path from the Podfile's directory`, where)
  return path
}

function readOption(strategy, option, node, where) {
  if (BOOLEANS.has(option)) return scalarOf(node, 'boolean', where)
  if (option === 'headers') return itemsOf(node, where).map((item, index) => textOf(item, `${where}[${index}]`))
  const value = textOf(node, where)
  if (option in HEX && !HEX[option](value)) throw new LockfileError(`${quote(value)} is not a ${option} in lowercase hex`, where)
  if (option === 'type' && !FILE_TYPES.has(value)) throw new LockfileError(`${quote(value)} is not a type of file CocoaPods extracts`, where)
  if (strategy === 'git' && (option === 'branch' || option === 'tag')) checkRefName(value, where)
  return value
}

function readUrl(strategy, node, where) {
  const url = textOf(node, where)
  if (strategy === 'http') checkHttpUrl(url, where)
  if (strategy === 'scp' && !(url.startsWith('scp://') && URL.canParse(url))) throw new LockfileError(`${quote(url)} is not an scp:// URL`, where)
  return checkRepo(url, where)
}

// The options of a mapping, by name, each with its node and where it is.
function readOptions(node, where) {
  const options = Object.create(null)
  for (const [key, value, here] of entriesOf(node, where)) {
    if (key.type !== 'symbol') throw new LockfileError('a key that is not a symbol, where CocoaPods reads options by symbol', here)
    options[key.value] = { node: value, where: here }
  }
  return options
}

// One way to download, with the options it takes alone: cocoapods-downloader
// refuses any other.
function readDownload(options, where) {
  const names = Object.keys(options)
  const strategies = names.filter((name) => name in DOWNLOADS)
  if (strategies.length === 0) throw new LockfileError('names no source CocoaPods knows: :podspec, :path, or one of :git, :hg, :http, :scp and :svn', where)
  if (strategies.length > 1) throw new LockfileError(`both :${strategies[0]} and :${strategies[1]}, which CocoaPods reads as no source at all`, where)
  const [strategy] = strategies
  const other = names.find((name) => name !== strategy && !DOWNLOADS[strategy].includes(name))
  if (other !== undefined) throw new LockfileError(`an option cocoapods-downloader does not take of :${strategy}`, options[other].where)
  const download = { type: strategy, url: readUrl(strategy, options[strategy].node, options[strategy].where) }
  for (const option of DOWNLOADS[strategy]) {
    const given = options[option]
    download[fieldOf(option)] = given === undefined ? undefined : readOption(strategy, option, given.node, given.where)
  }
  return download
}

// EXTERNAL SOURCES's entry of a root.
export function readExternalSource(node, where) {
  const options = readOptions(node, where)
  const type = 'podspec' in options ? 'podspec' : 'path' in options ? 'path' : undefined
  if (type === undefined) return readDownload(options, where)
  const carried = Object.create(null)
  for (const [name, { node: value, where: here }] of Object.entries(options)) {
    if (name === type) continue
    if (name === 'podspec' || name === 'path' || name in DOWNLOADS) throw new LockfileError(`beside :${type}, which CocoaPods reads alone`, here)
    carried[name] = scalarOf(value, 'string', here)
  }
  const { node: value, where: here } = options[type]
  const location = textOf(value, here)
  if (type === 'podspec' && /^https?:/iu.test(location)) checkHttpUrl(location, here)
  else checkPath(location, here)
  return { type, [type]: location, options: carried }
}

// CHECKOUT OPTIONS's entry of a root.
export const readCheckout = (node, where) => readDownload(readOptions(node, where), where)
