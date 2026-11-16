// A registry package as yarn 1 installs it, each mode given 0o644 and masked by a 0o022 umask as tar-fs
// does for yarn's fetcher, and held to what npm packs; and a directory by `file:`, as yarn's copy fetcher
// installs it

import { fromBase64 } from '@exodus/bytes/base64.js'
import { toHex } from '@exodus/bytes/hex.js'
import { getPublishTimes } from '@preventive/upstream/npm.js'
import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { sha1Hex } from '../hash.js'
import { readManifest } from '../manifest.js'
import { decodeUtf8, readBytes, typeOf } from '../project.js'
import { fetchTarball, fromMirror, isModules, ownTarball, sameFile, withDirs } from '../tarball.js'
import { fixLists } from './manifest.js'
import { kindOf, splitPattern } from './resolve.js'

const UMASK = 0o022

// Paths as tar-fs with `strip: 1` writes them: `.`, `..` and `//` folded.
function entriesOf(entries, where) {
  const files = new Map()
  const dirs = new Set()
  let top
  for (const entry of entries) {
    const slash = entry.storedName.indexOf('/')
    const first = slash === -1 ? entry.storedName : entry.storedName.slice(0, slash)
    if (top !== undefined && first !== top) throw new DeptreeError('the tarball has entries under more than one directory', where)
    top = first
    const path = slash === -1 ? '' : normalize(`/${entry.storedName.slice(slash + 1)}`).slice(1).replace(/\/$/u, '')
    if (isModules(path.split('/')[0])) throw new DeptreeError(`${quote(entry.storedName)} is in the package's own node_modules, where yarn installs its dependencies, which is not supported`, where)
    if (entry.type === 'directory') {
      if (path !== '') dirs.add(path)
      continue
    }
    if (entry.type !== 'file' && entry.type !== 'contiguous-file') throw new DeptreeError(`${quote(entry.storedName)} is a ${entry.type}, which is not supported`, where)
    if (path === '') throw new DeptreeError(`${quote(entry.storedName)} is a file at the top of the tarball`, where)
    const file = { data: entry.data, mode: (entry.mode | 0o644) & ~UMASK & 0o777 }
    const earlier = files.get(path)
    if (earlier !== undefined && !sameFile(earlier, file)) throw new DeptreeError(`${quote(path)} is in the tarball twice`, where)
    files.set(path, file)
  }
  return withDirs(files, where, dirs)
}

const decoder = new TextDecoder('utf-8', { fatal: true })

// yarn writes a sha1 alone where the registry has no sha512, which it has made for every version as it
// was published since then: firebase-tools@4.0.3, by npm 3.10.8, is the first it signed over one it made,
// and superstatic@6.0.0 the last over none
const SHA512_SINCE = '2018-08-05T14:58:16.253Z'

// The hex of an integrity that is a sha1 alone.
function sha1Of(integrity) {
  if (integrity === undefined || !/^sha1-[\d+/A-Za-z]{26}[048AEIMQUYcgkosw]=$/u.test(integrity)) return undefined
  return toHex(fromBase64(integrity.slice(5)))
}

// `name` is the one fetched, as an `npm:` alias asks for it. A pattern naming the tarball's URL has no
// integrity but the sha1 after its `#`, and one with a sha1 integrity alone has to be published before
// SHA512_SINCE: each is held to its sha1 and to the registry's sha512.
export function registryTarball(entry, name, where) {
  const { resolution } = entry
  if (resolution === undefined) throw new DeptreeError('a directory, by file: or link:, is not supported', where)
  const url = resolution.type === 'tarball' ? fromMirror(resolution.tarball) : resolution.tarball
  const byUrl = entry.patterns.some((pattern) => kindOf(splitPattern(pattern).range, where) === 'tarball')
  const sha1 = sha1Of(resolution.integrity)
  if (sha1 === undefined) return ownTarball(url, name, entry.version, resolution.integrity, where, byUrl && resolution.sha1 !== undefined)
  return { ...ownTarball(url, name, entry.version, undefined, where, true), sha1 }
}

// `times` keeps getPublishTimes' answer for each name, fetched once.
async function checkPublished({ name, version }, where, times) {
  if (!times.has(name)) times.set(name, getPublishTimes(name))
  const published = (await times.get(name)).get(version)
  if (published === undefined) throw new DeptreeError(`a sha1 integrity alone, where the registry gives no time ${name}@${version} was published at`, where)
  if (published >= SHA512_SINCE) throw new DeptreeError(`a sha1 integrity alone, which yarn does not write for ${name}@${version}, published at ${published}: the registry has given every version a sha512 since ${SHA512_SINCE}`, where)
}

export function checkSha1(pinned, sha1, where) {
  if (pinned !== undefined && sha1 !== pinned) throw new DeptreeError(`the tarball's sha1 is not ${pinned}`, where)
}

// Another entry of a package yarn's cache keeps in one place, held to the
// first's, `head`, as fetchYarnPackage holds that one: yarn fetches it once.
export async function checkShared({ name, version, integrity, sha1: pinned }, head, where, times) {
  if (pinned !== undefined) await checkPublished({ name, version }, where, times)
  checkSha1(pinned, head.sha1, where)
  if (integrity !== undefined && integrity !== head.integrity) throw new DeptreeError(`the tarball is not ${integrity}`, where)
}

// One the lockfile gives no sha512 is fetched by the registry's, as
// fetchTarball takes it unpinned.
export async function fetchYarnPackage({ name, version, integrity, sha1: pinned }, where, times, fetching) {
  if (pinned !== undefined) await checkPublished({ name, version }, where, times)
  const fetched = await fetchTarball(name, version, integrity, where, fetching)
  const sha1 = await sha1Hex(fetched.bytes)
  checkSha1(pinned, sha1, where)
  const { files, dirs } = entriesOf(fetched.entries, where)
  const file = files.get('package.json')
  if (file === undefined) throw new DeptreeError('the tarball has no package.json', where)
  let text
  try {
    text = decoder.decode(file.data)
  } catch {
    throw new DeptreeError('package.json is not UTF-8', where)
  }
  const manifest = readManifest(text, `${where}: package.json`)
  if (manifest.name !== name || manifest.version !== version) throw new DeptreeError(`package.json is for ${quote(`${manifest.name}@${manifest.version}`)}`, where)
  return { ...withBins({ files, dirs }, manifest, where), sha1, integrity: fetched.integrity, about: fetched.about }
}

// All in the directory, modes as they are, read from the project as yarn reads it at every install. No
// link, device or node_modules of its own in it, and a package.json of the name, version and lists its
// lockfile entry has, which yarn would install whatever they are.
export function readYarnDirectory(project, { name, version, entry, dir }, where) {
  if (typeOf(project, `/${dir}`, false) !== 'directory') throw new DeptreeError(`${quote(dir)} is not a directory of the project`, where)
  const files = new Map()
  const dirs = new Set()
  const walk = (at) => {
    for (const base of project.readdir(`/${dir}${at && `/${at}`}`)) {
      const path = at ? `${at}/${base}` : base
      const { type, mode } = project.lstat(`/${dir}/${path}`)
      if (at === '' && isModules(base)) throw new DeptreeError(`${quote(`${dir}/${path}`)} is its own node_modules, which yarn copies beside what it installs there, and which is not supported`, where)
      if (type === 'directory') {
        dirs.add(path)
        walk(path)
        continue
      }
      if (type !== 'file') throw new DeptreeError(`${quote(`${dir}/${path}`)} is a ${type}, which is not supported`, where)
      if (!Number.isInteger(mode)) throw new TypeError(`project.lstat must give a file's mode, and gives ${String(mode)} for ${quote(`/${dir}/${path}`)}`)
      if ((mode & ~0o777) !== 0) throw new DeptreeError(`${quote(`${dir}/${path}`)} has the mode ${mode.toString(8)}, which is not supported`, where)
      files.set(path, { data: readBytes(project, `/${dir}/${path}`), mode })
    }
  }
  walk('')
  const file = files.get('package.json')
  if (file === undefined) throw new DeptreeError(`${quote(dir)} has no package.json, where yarn makes one up`, where)
  const manifest = readManifest(decodeUtf8(file.data, 'package.json is not UTF-8', where), `${where}: package.json`)
  const why = 'which yarn reads anew, installing what it says'
  if (manifest.name !== name || manifest.version !== version) throw new DeptreeError(`package.json is for ${quote(`${manifest.name}@${manifest.version}`)}, not the lockfile's ${quote(`${name}@${version}`)}, ${why}`, where)
  const fixed = fixLists(manifest)
  for (const kind of ['dependencies', 'optionalDependencies']) {
    const listed = Object.entries(fixed[kind] ?? {}).map(([dep, range]) => `${dep}@${range}`).sort()
    const locked = Object.values(entry[kind] ?? {}).sort()
    if (listed.join('\n') !== locked.join('\n')) throw new DeptreeError(`package.json's ${kind} are not the lockfile's, ${why}`, where)
  }
  return withBins(withDirs(files, where, dirs), manifest, where)
}

// As yarn's fetcher leaves a package in its cache (base-fetcher.js): each
// bin's target chmod 755, and a .bin made for the links.
function withBins({ files, dirs }, manifest, where) {
  const bins = binsOf(manifest, { files, dirs })
  if (bins.size > 0 && files.has('.bin')) throw new DeptreeError('.bin is a file, where yarn fails to make a directory for the bins', where)
  for (const target of bins.values()) {
    if (isModules(target.split('/')[0])) throw new DeptreeError(`its bin ${quote(target)} is in its own node_modules, where yarn installs its dependencies, which is not supported`, where)
    const script = files.get(target.replace(/\/$/u, ''))
    if (script !== undefined) script.mode = 0o755
  }
  return { files, dirs, manifest, hasBins: bins.size > 0 }
}

// Bins as yarn's normalize-manifest reads them, targets normalized as Node's
// path.normalize does it, a trailing `/` kept.
const VALID_BIN_KEYS = /^(?!\.{0,2}$)[a-z0-9._-]+$/iu

const outside = (path) => path.startsWith('/') || path === '..' || path.startsWith('../')

function binsOf(manifest, { files, dirs }) {
  let { bin } = manifest
  if (typeof manifest.name === 'string' && typeof bin === 'string' && bin.length > 0) bin = { [manifest.name.replace(/^@[^/]+\//u, '')]: bin }
  const bins = new Map()
  if (bin !== null && typeof bin === 'object') {
    for (const [key, target] of Object.entries(bin)) {
      if (!VALID_BIN_KEYS.test(key)) continue
      if (typeof target !== 'string') throw new DeptreeError(`its bin ${quote(key)} is not a string, which yarn fails on`, quote(manifest.name))
      const path = normalize(target)
      if (!outside(path)) bins.set(key, path)
    }
    return bins
  }
  const binDir = manifest.directories?.bin
  if (typeof binDir === 'string' && binDir) {
    const dir = normalize(binDir).replace(/(?<=.)\/$/u, '')
    if (outside(dir)) throw new DeptreeError(`directories.bin, ${quote(binDir)}, is outside the package, which is not supported`, quote(manifest.name))
    if (files.has(dir)) throw new DeptreeError(`directories.bin, ${quote(binDir)}, is a file, which yarn fails to read as a directory`, quote(manifest.name))
    const prefix = dir === '.' ? '' : `${dir}/`
    for (const path of [...files.keys(), ...dirs]) {
      if (!path.startsWith(prefix)) continue
      const [first] = path.slice(prefix.length).split('/')
      if (first !== '' && !first.startsWith('.')) bins.set(first, `${prefix}${first}`)
    }
  }
  return bins
}
