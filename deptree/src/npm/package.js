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

export async function fetchNpmPackage({ name, version, integrity }, where, check, metadata) {
  const { bytes, entries, inflated, commit } = await fetchTarball(name, version, integrity, where, metadata)
  await check?.(bytes, inflated, where)
  return { ...unpack(entries, where), commit }
}
