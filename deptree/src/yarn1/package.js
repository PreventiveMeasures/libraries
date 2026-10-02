// A registry package as yarn 1 installs it: its tarball held to the
// lockfile's sha512, and its sha1 taken for tree.js to check the one after
// the `#` of each entry's URL against, as yarn checks both; unpacked as
// yarn's tarball fetcher does with tar-fs, each name's first segment
// dropped and each mode given 0o644 and masked by a 0o022 umask; and its
// package.json read as normalize-manifest reads it.
//
// Held to more than yarn holds it to: a lockfile URL that is the registry's
// own, as npm spells it, or yarn's mirror's; and what npm packs, a gzipped
// tarball with every entry under one directory, none in its own
// node_modules (npm packs those only for bundled dependencies), no link or
// device, no name twice as two different files, and a package.json of the
// lockfile's name and version.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { sha1Hex } from '../hash.js'
import { readManifest } from '../manifest.js'
import { fetchTarball, fromMirror, sameFile, tarballUrl } from '../tarball.js'

const UMASK = 0o022

// Paths as tar-fs with `strip: 1` writes them: the first segment dropped,
// and `.`, `..` and empty segments folded.
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
    if (path.split('/')[0] === 'node_modules') throw new DeptreeError(`${quote(entry.storedName)} is in the package's own node_modules, where yarn installs its dependencies, which is not supported`, where)
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
  for (const path of files.keys()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  for (const dir of dirs) if (files.has(dir)) throw new DeptreeError(`${quote(dir)} is both a file and a directory in the tarball`, where)
  return { files, dirs }
}

const decoder = new TextDecoder('utf-8', { fatal: true })

// `name` is the one fetched, as an `npm:` alias asks for it.
export function registryTarball(entry, name, where) {
  const { resolution } = entry
  if (resolution === undefined) throw new DeptreeError('a directory, by file: or link:, is not supported', where)
  const expected = tarballUrl(name, entry.version)
  const url = resolution.type === 'tarball' ? fromMirror(resolution.tarball) : resolution.tarball
  if (url !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${entry.version}, ${expected}, is supported`, where)
  const sha512 = resolution.integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version: entry.version, integrity: sha512 }
}

export async function fetchYarnPackage({ name, version, integrity }, where) {
  const { bytes, entries } = await fetchTarball(name, version, integrity, where)
  const sha1 = await sha1Hex(bytes)
  const { files, dirs } = entriesOf(entries, where)
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
  // As yarn's fetcher leaves the package in the cache it copies it from
  // (base-fetcher.js): each bin's target chmod 755, and a .bin made for the
  // links, which it fails to make over a file.
  const bins = binsOf(manifest, { files, dirs })
  if (bins.size > 0 && files.has('.bin')) throw new DeptreeError('.bin is a file, where yarn fails to make a directory for the bins', where)
  for (const target of bins.values()) {
    if (target.split('/')[0] === 'node_modules') throw new DeptreeError(`its bin ${quote(target)} is in its own node_modules, where yarn installs its dependencies, which is not supported`, where)
    const script = files.get(target.replace(/\/$/u, ''))
    if (script !== undefined) script.mode = 0o755
  }
  return { files, dirs, manifest, sha1, hasBins: bins.size > 0 }
}

// Bins as yarn's normalize-manifest reads them: a string `bin` named for
// the package without its scope; an invalid name, or a target outside the
// package, dropped; with no `bin`, each name in directories.bin but one
// with a leading dot. Targets are normalized as Node's path.normalize, and
// vfs's, do it: a trailing `/` kept.
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
