// A registry package as yarn 1 installs it: its tarball fetched through
// @preventive/upstream and held to the lockfile's sha512 integrity, and to
// the sha1 after the `#` of its URL where there is one, as yarn checks
// both; unpacked as yarn's tarball fetcher unpacks it, with tar-fs, the
// first segment of each name dropped, each file's mode with 0o644 added
// and masked by a umask of 0o022; and its package.json read as yarn's
// normalize-manifest reads the fields it installs by.
//
// Held to more than yarn holds it to, to what npm packs: a gzipped
// tarball, every entry under one directory, by a name with no `.` or `..`
// segment, none in a node_modules, no link of either kind or device, no
// name twice as two different files; and a package.json for exactly the
// name and version the lockfile has.

import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { DeptreeError, quote } from '../error.js'
import { matchesIntegrity, sha1Hex } from '../hash.js'
import { sameBytes, tarballUrl } from '../tarball.js'

const MAX_BYTES = 512 * 1024 * 1024
const UMASK = 0o022

// The registries yarn and npm write tarball URLs of, which serve the same
// tarballs.
const REGISTRIES = new Set(['registry.yarnpkg.com', 'registry.npmjs.org'])

// Each entry by its path in the package, as tar-fs writes it with
// `strip: 1`: files with their bytes and mode, and directories.
function entriesOf(entries, where) {
  const files = new Map()
  const dirs = new Set()
  let top
  for (const entry of entries) {
    const segments = entry.storedName.split('/')
    if (segments.at(-1) === '' && entry.type === 'directory') segments.pop()
    const [first, ...rest] = segments
    if (top !== undefined && first !== top) throw new DeptreeError('the tarball has entries under more than one directory', where)
    top = first
    if (first === '' || first === '.' || first === '..' || rest.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new DeptreeError(`${quote(entry.storedName)} is a name not read here`, where)
    }
    const path = rest.join('/')
    if (rest.includes('node_modules')) throw new DeptreeError(`${quote(entry.storedName)} is in a node_modules, which yarn copies into the tree as it is, and which is not supported`, where)
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

// The package.json, as yarn's readJson reads it: a byte order mark dropped.
function readManifest(files, where) {
  const file = files.get('package.json')
  if (file === undefined) throw new DeptreeError('the tarball has no package.json', where)
  let manifest
  try {
    manifest = JSON.parse(decoder.decode(file.data).replace(/^﻿/u, ''))
  } catch {
    throw new DeptreeError('package.json is not JSON', where)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('package.json is not an object', where)
  return manifest
}

// The registry's tarball of a lockfile entry: its name, as an `npm:` alias
// asks for it; held to be the registry's URL for that name and version.
export function registryTarball(entry, name, where) {
  const { resolution } = entry
  if (resolution === undefined) throw new DeptreeError('a directory, by file: or link:, is not supported', where)
  if (resolution.type !== 'tarball' || resolution.tarball.startsWith('file:')) throw new DeptreeError(`only packages from ${[...REGISTRIES].join(' or ')} are supported`, where)
  const url = new URL(resolution.tarball)
  if (url.protocol !== 'https:' || !REGISTRIES.has(url.hostname) || url.search !== '' || url.hash !== '') {
    throw new DeptreeError(`only packages from ${[...REGISTRIES].join(' or ')} are supported`, where)
  }
  const expected = new URL(tarballUrl(name, entry.version))
  if (url.pathname.replace(/^(\/@[^/]+)%2f/iu, '$1/') !== expected.pathname) throw new DeptreeError(`${quote(resolution.tarball)} is not the registry's tarball of ${name}@${entry.version}`, where)
  const sha512 = resolution.integrity?.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version: entry.version, integrity: sha512, sha1: resolution.sha1 }
}

// The package's entries, and its package.json as parsed.
export async function fetchYarnPackage({ name, version, integrity, sha1 }, where) {
  const bytes = await getTarball(name, version, { tarball: tarballUrl(name, version), integrity })
  if (!await matchesIntegrity(bytes, integrity)) throw new DeptreeError(`the tarball is not ${integrity}`, where)
  if (sha1 !== undefined && await sha1Hex(bytes) !== sha1) throw new DeptreeError(`the tarball's sha1 is not ${sha1}`, where)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError('the tarball is not gzipped', where)
  const { files, dirs } = entriesOf(unpack(await decompress(bytes, 'gzip', { limit: MAX_BYTES })), where)
  const manifest = readManifest(files, where)
  if (manifest.name !== name || manifest.version !== version) throw new DeptreeError(`package.json is for ${quote(`${manifest.name}@${manifest.version}`)}`, where)
  return { files, dirs, manifest }
}

// A bin's name, and its target as a path in the package, as yarn's
// normalize-manifest has them: a string `bin` named for the package, its
// scope dropped; a name that is not valid, or a target outside the
// package, dropped; with no `bin`, each name in directories.bin but for
// one with a leading dot. `dirs` and `files` the package's. A target is
// normalized as Node's path.normalize does, a trailing `/` kept.
const VALID_BIN_KEYS = /^(?!\.{0,2}$)[a-z0-9._-]+$/iu

function normalizePath(path) {
  const absolute = path.startsWith('/')
  const out = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (segment !== '..' || !absolute) out.push(segment)
  }
  const normal = (absolute ? '/' : '') + (out.join('/') || (absolute ? '' : '.'))
  return path.endsWith('/') && !normal.endsWith('/') ? `${normal}/` : normal
}

const outside = (path) => path.startsWith('/') || path === '..' || path.startsWith('../')

export function binsOf(manifest, { files, dirs }) {
  let { bin } = manifest
  if (typeof manifest.name === 'string' && typeof bin === 'string' && bin.length > 0) bin = { [manifest.name.replace(/^@[^/]+\//u, '')]: bin }
  const bins = new Map()
  if (bin !== null && typeof bin === 'object') {
    for (const [key, target] of Object.entries(bin)) {
      if (!VALID_BIN_KEYS.test(key)) continue
      if (typeof target !== 'string') throw new DeptreeError(`its bin ${quote(key)} is not a string, which yarn fails on`, quote(manifest.name))
      const path = normalizePath(target)
      if (!outside(path)) bins.set(key, path)
    }
    return bins
  }
  const binDir = manifest.directories?.bin
  if (typeof binDir === 'string' && binDir) {
    const dir = normalizePath(binDir).replace(/(?<=.)\/$/u, '')
    if (outside(dir)) throw new DeptreeError(`directories.bin, ${quote(binDir)}, is outside the package, which is not supported`, quote(manifest.name))
    if (files.has(dir)) throw new DeptreeError(`directories.bin, ${quote(binDir)}, is a file, which yarn fails to read as a directory`, quote(manifest.name))
    const prefix = dir === '.' ? '' : `${dir}/`
    const names = new Set()
    for (const path of [...files.keys(), ...dirs]) {
      if (!path.startsWith(prefix)) continue
      const [first] = path.slice(prefix.length).split('/')
      if (first !== '' && !first.startsWith('.')) names.add(first)
    }
    for (const name of [...names].sort()) bins.set(name, normalizePath(`${prefix}${name}`))
  }
  return bins
}
