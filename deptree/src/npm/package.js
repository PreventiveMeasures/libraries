// A tarball unpacked as pacote has tar unpack it: files alone, so no empty
// directory; modes with read and write for all, less a 0o022 umask, and no
// execute bits added, as npm reads no packument for a resolved URL. Where a
// .npmignore follows a .gitignore renamed to it, tar writes the second's
// bytes into the first's file, keeping its mode. What tar's releases read
// otherwise, or npm never packs, is refused.

import { DeptreeError, quote } from '../error.js'
import { fetchTarball, fromMirror, isModules, ownTarball, withDirs } from '../tarball.js'

const UMASK = 0o022

// npm's URL, a scope's `/` as `/`, which npm may write `%2f`.
const asNpm = (url) => fromMirror(url).replace(/^(https:\/\/registry\.npmjs\.org\/@[^/]+)%2f/iu, '$1/')

export function registryTarball({ name, version, resolution }, where) {
  if (resolution === undefined) throw new DeptreeError('a package bundled in another is not supported', where)
  if (resolution.type === 'git') throw new DeptreeError('a git repository is not supported', where)
  if (resolution.tarball === undefined) throw new DeptreeError('a package with no resolved URL, which npm fetches by the registry\'s packument, whose bins it makes executable, is not supported', where)
  return ownTarball(asNpm(resolution.tarball), name, version, resolution.integrity, where)
}

const FILES = new Set(['file', 'contiguous-file'])

// The headers that stand ahead of an entry: pax, global, long name, long link.
const EXTENDED = new Set([0x78, 0x67, 0x4c, 0x4b])
const PAX = 0x78
const BLOCK = 512
const blocks = (size) => BLOCK * Math.ceil(size / BLOCK)

// An extended header's size as the archive reader read it, which held it to
// 1 MiB: base 256, or octal digits to a NUL, a blank field 0.
function extendedSize(tar, at) {
  const field = tar.subarray(at + 124, at + 136)
  if (field[0] === 0x80 || field[0] === 0xff) return field.subarray(1).reduce((size, byte) => size * 256 + byte, 0)
  const digits = /^ *([0-7]*)/u.exec(String.fromCodePoint(...field).split('\0')[0])[1]
  return digits === '' ? 0 : Number.parseInt(digits, 8)
}

// Every tar release takes a pax size over the header's. Up to 7.5.15, as
// npm 10.9.8 and 11.16 and before bundle it, tar reads it into each header
// after the pax one up to its entry too, so a long name, a long link or a
// global header between them is read by it, and all that follows otherwise
// than later releases read it. The archive reader has checked the layout
// whole, so each header is where the sizes it took say.
function checkPaxSizes(tar, entries, where) {
  if (!entries.some(({ pax }) => pax.has('size'))) return
  let at = 0
  for (const { storedName, data, pax } of entries) {
    let afterPax = false
    let between = false
    for (let flag = tar[at + 156]; EXTENDED.has(flag); flag = tar[at + 156]) {
      between ||= afterPax
      afterPax ||= flag === PAX
      at += BLOCK + blocks(extendedSize(tar, at))
    }
    if (between && pax.has('size')) throw new DeptreeError(`${quote(storedName)} has a pax size ahead of another extended header, which tar's releases read otherwise`, where)
    at += BLOCK + blocks(data.length)
  }
  if (tar.length < at + 2 * BLOCK || tar.subarray(at, at + 2 * BLOCK).some((byte) => byte !== 0)) throw new Error('unreachable: no end of the archive where the archive reader found one')
}

function unpack(entries, where) {
  const files = new Map()
  const ignores = new Set()
  let top
  for (const { storedName, storedLinkname, type, mode, data, globalPax } of entries) {
    const segments = storedName.replace(/(?<=.)\/$/u, '').split('/')
    if (segments.length > 1024 || /[\\\0]/u.test(storedName) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new DeptreeError(`${quote(storedName)} is a name tar reads otherwise`, where)
    }
    if (globalPax.size > 0) throw new DeptreeError(`${quote(storedName)} has a pax header tar's releases read otherwise`, where)
    if (top !== undefined && segments[0] !== top) throw new DeptreeError('the tarball has entries under more than one directory', where)
    top = segments[0]
    if (!FILES.has(type)) continue
    if (storedLinkname !== '') throw new DeptreeError(`${quote(storedName)} is a file with a link name, which tar's releases read otherwise`, where)
    if (segments.length === 1) throw new DeptreeError(`${quote(storedName)} is a file at the top of the tarball`, where)
    if (isModules(segments[1])) throw new DeptreeError(`${quote(storedName)} is in the package's own node_modules, where npm installs its dependencies, which is not supported`, where)
    if ((mode & 0o7000) !== 0) throw new DeptreeError(`${quote(storedName)} has a setuid, setgid or sticky bit, which is not supported`, where)
    let path = segments.slice(1).join('/')
    if (segments.at(-1) === '.npmignore') ignores.add(path)
    else if (segments.at(-1) === '.gitignore') {
      path = path.replace(/\.gitignore$/u, '.npmignore')
      if (ignores.has(path)) continue
    }
    files.set(path, { data, mode: files.get(path)?.mode ?? ((mode | 0o666) & ~UMASK & 0o777) })
  }
  return withDirs(files, where)
}

export async function fetchNpmPackage({ name, version, integrity }, where, check, fetching) {
  const { bytes, tar, entries, inflated, about } = await fetchTarball(name, version, integrity, where, fetching)
  await check?.(bytes, inflated, where)
  checkPaxSizes(tar, entries, where)
  return { ...unpack(entries, where), about }
}
