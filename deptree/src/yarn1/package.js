// A registry package as yarn 1 installs it: its tarball fetched through
// @preventive/upstream and held to the lockfile's sha512 integrity, and to
// the sha1 after the `#` of its URL where there is one, as yarn checks
// both; unpacked as yarn's tarball fetcher unpacks it, with tar-fs, the
// first segment of each name dropped, each file's mode with 0o644 added
// and masked by a umask of 0o022; and its package.json read as yarn's
// normalize-manifest reads the fields it installs by.
//
// Held to more than yarn holds it to: a lockfile's URL of it that is the
// registry's own, as npm spells it, or that on yarn's mirror; and to what
// npm packs: a gzipped tarball, every entry under one directory, none in
// the package's own node_modules, which npm packs only for bundled
// dependencies, no link of either kind or device, no name twice as two
// different files; and a package.json for exactly the name and version
// the lockfile has.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { sha1Hex } from '../hash.js'
import { REGISTRY, fetchTarball, sameBytes, tarballUrl } from '../tarball.js'
import { readManifest } from './manifest.js'

const UMASK = 0o022

// yarn's mirror of npm's registry, which serves the same tarballs at the
// same paths.
const YARNPKG = 'https://registry.yarnpkg.com/'

// Each entry by its path in the package, as tar-fs writes it with
// `strip: 1`: its first segment dropped, and the rest joined to the
// package's directory as a path from `/`, so `.`, `..` and empty segments
// folded; files with their bytes and mode, and directories.
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
    if (earlier !== undefined && !(earlier.mode === file.mode && sameBytes(earlier.data, file.data))) throw new DeptreeError(`${quote(path)} is in the tarball twice`, where)
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

// The registry's tarball of a lockfile entry: its name, as an `npm:` alias
// asks for it; held to be the registry's own URL for that name and
// version, exactly as npm spells it, yarn's mirror taken for npm's.
export function registryTarball(entry, name, where) {
  const { resolution } = entry
  if (resolution === undefined) throw new DeptreeError('a directory, by file: or link:, is not supported', where)
  const expected = tarballUrl(name, entry.version)
  const url = resolution.type === 'tarball' && resolution.tarball.startsWith(YARNPKG) ? `${REGISTRY}${resolution.tarball.slice(YARNPKG.length)}` : resolution.tarball
  if (url !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${entry.version}, ${expected}, is supported`, where)
  const sha512 = resolution.integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version: entry.version, integrity: sha512, sha1: resolution.sha1 }
}

// The package's entries, as yarn's fetcher leaves them, and its
// package.json as parsed.
export async function fetchYarnPackage({ name, version, integrity, sha1 }, where) {
  const { bytes, entries } = await fetchTarball(name, version, integrity, where)
  if (sha1 !== undefined && await sha1Hex(bytes) !== sha1) throw new DeptreeError(`the tarball's sha1 is not ${sha1}`, where)
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
  // As yarn's fetcher leaves the package in its cache, from which it copies
  // it wherever it goes (base-fetcher.js): each bin's target made
  // executable, chmod 755, a trailing `/` of it dropped; and a .bin made
  // for links to them, which it fails to make over a file.
  const bins = binsOf(manifest, { files, dirs })
  if (bins.size > 0 && files.has('.bin')) throw new DeptreeError('.bin is a file, where yarn fails to make a directory for the bins', where)
  for (const target of bins.values()) {
    if (target.split('/')[0] === 'node_modules') throw new DeptreeError(`its bin ${quote(target)} is in its own node_modules, where yarn installs its dependencies, which is not supported`, where)
    const script = files.get(target.replace(/\/$/u, ''))
    if (script !== undefined) script.mode = 0o755
  }
  return { files, dirs, manifest }
}

// A bin's name, and its target as a path in the package, as yarn's
// normalize-manifest has them: a string `bin` named for the package, its
// scope dropped; a name that is not valid, or a target outside the
// package, dropped; with no `bin`, each name in directories.bin but for
// one with a leading dot. `dirs` and `files` the package's. A target is
// normalized as Node's path.normalize does it, which is as vfs's does: a
// trailing `/` kept.
const VALID_BIN_KEYS = /^(?!\.{0,2}$)[a-z0-9._-]+$/iu

const outside = (path) => path.startsWith('/') || path === '..' || path.startsWith('../')

export function binsOf(manifest, { files, dirs }) {
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
    const names = new Set()
    for (const path of [...files.keys(), ...dirs]) {
      if (!path.startsWith(prefix)) continue
      const [first] = path.slice(prefix.length).split('/')
      if (first !== '' && !first.startsWith('.')) names.add(first)
    }
    for (const name of names) bins.set(name, `${prefix}${name}`)
  }
  return bins
}
