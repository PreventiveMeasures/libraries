// Where each package of the lockfile installs, and from what: a metapackage
// nowhere; any other into vendor-dir/<name>, under its target-dir if any,
// from its dist, a zip, as Composer prefers one by default. A dist with a
// shasum is fetched and held to it, as Composer holds it; one without, of
// GitHub's alone, is held to the commit's tree.

import { DeptreeError, quote } from '../error.js'
import { isInside } from '../mount.js'

const GITHUB_ZIPBALL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/zipball\/([\da-f]{40})$/u
const DRUPAL_ZIP = /^https:\/\/ftp\.drupal\.org\/files\/projects\/[^/]+\.zip$/u

export const about = (key) => `packages[${quote(key)}]`

function installPath(vendorDir, pkg, where) {
  // vendor/bin holds Composer's proxies of the bins.
  if (pkg.name.split('/')[0] === 'bin') throw new DeptreeError('a package installed into vendor/bin, where Composer writes the bins, is not supported', where)
  // PHP takes "0" for no target-dir, as it does "".
  const target = pkg.targetDir === '0' ? '' : pkg.targetDir ?? ''
  if (target !== '' && (target.includes('\\') || !isInside(target))) throw new DeptreeError(`target-dir ${quote(target)} is not supported: only plain names between slashes are`, where)
  return [vendorDir, pkg.name, target].filter((part) => part !== '').join('/')
}

function sourceOf(pkg, preference, where) {
  const { dist, source } = pkg
  if (dist === undefined && source === undefined) throw new DeptreeError('a package with neither a dist nor a source, which Composer fails on', where)
  if (dist === undefined || (source !== undefined && preference === 'source')) {
    throw new DeptreeError(`a package installed from source, a ${source.type} clone, ${dist === undefined ? 'as it has no dist' : 'as preferred-install has it'}, is not supported`, where)
  }
  if (dist.type !== 'zip') throw new DeptreeError(`a ${dist.type} dist is not supported: only a zip is`, where)
  if (dist.mirrors.some(({ preferred }) => preferred)) throw new DeptreeError('a dist with a preferred mirror, which Composer downloads from first, is not supported', where)
  const github = GITHUB_ZIPBALL.exec(dist.url)
  if (dist.shasum !== undefined) {
    if (github === null && !DRUPAL_ZIP.test(dist.url)) throw new DeptreeError(`a dist from ${quote(dist.url)} is not supported: only a release zip on ftp.drupal.org and GitHub's zipball of a commit are`, where)
    return { url: dist.url, shasum: dist.shasum }
  }
  if (github === null) throw new DeptreeError(`a dist from ${quote(dist.url)}, with no shasum to hold it to, is not supported: only GitHub's zipball of a commit is, held to the commit's tree`, where)
  return { repo: github[1], commit: github[2] }
}

// Each package, in the lockfile's order, `key` its name in lowercase.
export function planOf(lock, { vendorDir, preference }) {
  return Object.entries(lock.packages).map(([key, pkg]) => {
    const where = about(key)
    const plan = { key, name: pkg.name, version: pkg.version, type: pkg.type, dev: pkg.dev, bin: pkg.bin }
    if (pkg.type === 'metapackage') return { ...plan, path: null }
    return { ...plan, path: installPath(vendorDir, pkg, where), from: sourceOf(pkg, preference(pkg), where) }
  })
}
