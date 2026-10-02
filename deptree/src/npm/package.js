// A registry package as npm ci installs it: its tarball held to the
// lockfile's sha512, and unpacked as pacote has tar unpack it. The first
// segment of each name is dropped, whatever it is. A file alone is kept:
// a link, a device and a directory entry are passed over, so no directory
// is made but those files are in. A file's mode is the tarball's with read
// and write for all added, then the umask of 0o022 taken off, its execute
// bits kept: npm adds none for a package with a resolved URL, as it fetches
// no packument to read its bins from. A .gitignore is renamed .npmignore,
// and dropped where a .npmignore came before it in its directory; where
// one comes after it, the file keeps the first's mode and the second's
// bytes, as tar writes into the file it made.
//
// Held to more than npm holds it to, as what npm packs always is: every
// entry under one directory, a name tar reads as it is stored, the same in
// every release, with no `\` and no more than 1024 segments, none in the
// package's own node_modules (npm packs those only for bundled
// dependencies), no setuid, setgid or sticky bit, no link name on a file,
// and no pax header but per entry, nor one with a size, which tar's
// releases read otherwise.

import { DeptreeError, quote } from '../error.js'
import { fetchTarball, fromMirror, tarballUrl } from '../tarball.js'

const UMASK = 0o022

// npm's URL, a scope's `/` as `/`, which npm may write `%2f`.
const asNpm = (url) => fromMirror(url).replace(/^(https:\/\/registry\.npmjs\.org\/@[^/]+)%2f/iu, '$1/')

export function registryTarball({ name, version, resolution }, where) {
  if (resolution === undefined) throw new DeptreeError('a package bundled in another is not supported', where)
  if (resolution.type === 'git') throw new DeptreeError('a git repository is not supported', where)
  if (resolution.tarball === undefined) throw new DeptreeError('a package with no resolved URL, which npm fetches by the registry\'s packument, whose bins it makes executable, is not supported', where)
  const expected = tarballUrl(name, version)
  if (asNpm(resolution.tarball) !== expected) throw new DeptreeError(`only the registry's own tarball of ${name}@${version}, ${expected}, is supported`, where)
  const sha512 = resolution.integrity.split(' ').find((part) => part.startsWith('sha512-'))
  if (sha512 === undefined) throw new DeptreeError('a tarball with no sha512 integrity is not supported', where)
  return { name, version, integrity: sha512 }
}

const FILES = new Set(['file', 'contiguous-file'])

function unpack(entries, where) {
  const files = new Map()
  const ignores = new Set()
  let top
  for (const { storedName, storedLinkname, type, mode, data, pax, globalPax } of entries) {
    const segments = storedName.replace(/(?<=.)\/$/u, '').split('/')
    if (segments.length > 1024 || /[\\\0]/u.test(storedName) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new DeptreeError(`${quote(storedName)} is a name tar reads otherwise`, where)
    }
    if (globalPax.size > 0 || pax.has('size')) throw new DeptreeError(`${quote(storedName)} has a pax header tar's releases read otherwise`, where)
    if (top !== undefined && segments[0] !== top) throw new DeptreeError('the tarball has entries under more than one directory', where)
    top = segments[0]
    if (!FILES.has(type)) continue
    if (storedLinkname !== '') throw new DeptreeError(`${quote(storedName)} is a file with a link name, which tar's releases read otherwise`, where)
    if (segments.length === 1) throw new DeptreeError(`${quote(storedName)} is a file at the top of the tarball`, where)
    if (segments[1] === 'node_modules') throw new DeptreeError(`${quote(storedName)} is in the package's own node_modules, where npm installs its dependencies, which is not supported`, where)
    if ((mode & 0o7000) !== 0) throw new DeptreeError(`${quote(storedName)} has a setuid, setgid or sticky bit, which is not supported`, where)
    let path = segments.slice(1).join('/')
    if (segments.at(-1) === '.npmignore') ignores.add(path)
    else if (segments.at(-1) === '.gitignore') {
      path = path.replace(/\.gitignore$/u, '.npmignore')
      if (ignores.has(path)) continue
    }
    files.set(path, { data, mode: files.get(path)?.mode ?? ((mode | 0o666) & ~UMASK & 0o777) })
  }
  const dirs = new Set()
  for (const path of files.keys()) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  for (const dir of dirs) if (files.has(dir)) throw new DeptreeError(`${quote(dir)} is both a file and a directory in the tarball`, where)
  return { files, dirs }
}

export async function fetchNpmPackage({ name, version, integrity }, where, check) {
  const { bytes, entries, inflated } = await fetchTarball(name, version, integrity, where)
  await check?.(bytes, inflated, where)
  return unpack(entries, where)
}
