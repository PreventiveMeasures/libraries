// What a Podfile names a pod's external source by, as EXTERNAL SOURCES has
// it, and what CocoaPods would download it again by, as CHECKOUT OPTIONS
// has it: options by symbol, as the Podfile gives them to `pod`, which
// CocoaPods reads by ExternalSources.from_params and cocoapods-downloader.
// A `:podspec` comes first, then a `:path`, then one way to download;
// anything else beside a `:podspec` or a `:path` CocoaPods carries along,
// and passes over, and it is handed back as `options`.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRepo, isHttpUrl } from '../names.js'

// cocoapods-downloader's strategies, each with the options it takes, and
// the field each is handed back as.
export const DOWNLOADS = {
  __proto__: null,
  git: ['commit', 'tag', 'branch', 'submodules'],
  hg: ['revision', 'tag', 'branch'],
  http: ['type', 'flatten', 'sha1', 'sha256', 'headers'],
  scp: ['type', 'flatten', 'sha1', 'sha256', 'headers'],
  svn: ['revision', 'tag', 'folder', 'externals', 'checkout'],
}
export const fieldOf = (option) => (option === 'type' ? 'fileType' : option)

const BOOLEANS = new Set(['submodules', 'flatten', 'externals', 'checkout'])
// What RemoteFile extracts, by `:type`.
const FILE_TYPES = new Set(['zip', 'tgz', 'tar', 'tbz', 'txz', 'dmg'])

const kindOf = (node) => (node.kind === 'scalar' ? (node.type === 'string' ? `the string ${quote(node.value)}` : `the ${node.type} ${String(node.value)}`) : `a ${node.kind === 'map' ? 'mapping' : 'sequence'}`)

export function scalarOf(node, type, where) {
  if (node.kind !== 'scalar' || node.type !== type) throw new LockfileError(`expected a ${type}, found ${kindOf(node)}`, where)
  return node.value
}

export function textOf(node, where) {
  const value = scalarOf(node, 'string', where)
  if (value === '') throw new LockfileError('expected a non-empty string', where)
  return value
}

// A path from the Podfile's directory, as the Podfile has it: CocoaPods
// takes `./`, `..` and a `/` at the end as they are, but nothing absolute,
// from home, or with a backslash.
function checkPath(path, where) {
  if (/^(?:[/~]|[A-Za-z]:)/u.test(path) || path.includes('\\') || path.includes('//')) {
    throw new LockfileError(`${quote(path)} is not a path from the Podfile's directory`, where)
  }
  return path
}

const HEX = { commit: /^[\da-f]{4,64}$/u, sha1: /^[\da-f]{40}$/u, sha256: /^[\da-f]{64}$/u }

function readOption(strategy, option, node, where) {
  if (BOOLEANS.has(option)) return scalarOf(node, 'boolean', where)
  if (option === 'headers') {
    if (node.kind !== 'seq') throw new LockfileError(`expected a sequence, found ${kindOf(node)}`, where)
    return node.items.map((item, index) => textOf(item, `${where}[${index}]`))
  }
  const value = textOf(node, where)
  if (option in HEX && !HEX[option].test(value)) throw new LockfileError(`${quote(value)} is not a ${option === 'commit' ? 'commit' : option} in lowercase hex`, where)
  if (option === 'type' && !FILE_TYPES.has(value)) throw new LockfileError(`${quote(value)} is not a type of file CocoaPods extracts`, where)
  if (strategy === 'git' && (option === 'branch' || option === 'tag')) checkRefName(value, where)
  return value
}

function readUrl(strategy, node, where) {
  const url = textOf(node, where)
  if (strategy === 'http' ? !isHttpUrl(url) : strategy === 'scp' && !(url.startsWith('scp://') && URL.canParse(url))) {
    throw new LockfileError(`${quote(url)} is not an ${strategy === 'http' ? 'http(s)' : 'scp://'} URL`, where)
  }
  return checkRepo(url, where)
}

// The options of a mapping, by name, each with its node and where it is.
function readOptions(node, where) {
  if (node.kind !== 'map') throw new LockfileError(`expected a mapping, found ${kindOf(node)}`, where)
  const options = Object.create(null)
  for (const { key, value } of node.entries) {
    const here = at(where, key.type === 'symbol' ? `:${key.value}` : String(key.value))
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
  if (type === undefined) return { source: readDownload(options, where), options }
  const carried = Object.create(null)
  for (const [name, { node: value, where: here }] of Object.entries(options)) {
    if (name === type) continue
    if (name === 'podspec' || name === 'path' || name in DOWNLOADS) throw new LockfileError(`beside :${type}, which CocoaPods reads alone`, here)
    carried[name] = scalarOf(value, 'string', here)
  }
  const { node: value, where: here } = options[type]
  const location = textOf(value, here)
  if (type === 'path' || !/^https?:/iu.test(location)) checkPath(location, here)
  else if (!isHttpUrl(location)) throw new LockfileError(`${quote(location)} is not an http(s) URL`, here)
  return { source: { type, [type]: location, options: carried }, options }
}

// CHECKOUT OPTIONS's entry of a root.
export const readCheckout = (node, where) => readDownload(readOptions(node, where), where)
