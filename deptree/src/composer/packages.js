// Where each package of the lockfile installs, and from what: a metapackage
// nowhere; any other into vendor-dir/<name>, under its target-dir if any,
// from its dist, a zip, as Composer prefers one by default. A dist with a
// shasum is fetched and held to it, as Composer holds it; one without, of
// GitHub's alone, is held to the commit's tree.

import { readDistUrl } from '@preventive/upstream/composer.js'
import { DeptreeError, quote } from '../error.js'
import { fold, isInside } from '../mount.js'

export const about = (key) => `packages[${quote(key)}]`

// bin-dir holds Composer's proxies of the bins, which neither a package's
// directory may be in nor it in one; on macOS, by names as it takes them.
function installPath({ vendorDir, binDir }, pkg, folded, where) {
  // PHP takes "0" for no target-dir, as it does "".
  const target = pkg.targetDir === '0' ? '' : pkg.targetDir ?? ''
  if (target !== '' && (target.includes('\\') || !isInside(target))) throw new DeptreeError(`target-dir ${quote(target)} is not supported: only plain names between slashes are`, where)
  const path = [vendorDir, pkg.name, target].filter((part) => part !== '').join('/')
  const [mine, bins] = [path, binDir].map((dir) => (folded ? fold(dir) : dir))
  if (mine === bins || mine.startsWith(`${bins}/`) || bins.startsWith(`${mine}/`)) throw new DeptreeError(`a package installed where Composer proxies the bins, ${quote(binDir)}, is not supported`, where)
  return path
}

function sourceOf(pkg, preference, where) {
  const { dist, source } = pkg
  if (dist === undefined && source === undefined) throw new DeptreeError('a package with neither a dist nor a source, which Composer fails on', where)
  if (dist === undefined || (source !== undefined && preference === 'source')) {
    throw new DeptreeError(`a package installed from source, a ${source.type} clone, ${dist === undefined ? 'as it has no dist' : 'as preferred-install has it'}, is not supported`, where)
  }
  if (dist.type !== 'zip') throw new DeptreeError(`a ${dist.type} dist is not supported: only a zip is`, where)
  if (dist.mirrors.some(({ preferred }) => preferred)) throw new DeptreeError('a dist with a preferred mirror, which Composer downloads from first, is not supported', where)
  const known = readDistUrl(dist.url)
  if (dist.shasum !== undefined) {
    if (known === null) throw new DeptreeError(`a dist from ${quote(dist.url)} is not supported: only a release zip on ftp.drupal.org and GitHub's zipball of a commit are`, where)
    return { url: dist.url, shasum: dist.shasum }
  }
  if (known?.repo === undefined) throw new DeptreeError(`a dist from ${quote(dist.url)}, with no shasum to hold it to, is not supported: only GitHub's zipball of a commit is, held to the commit's tree`, where)
  return { repo: known.repo, commit: known.commit }
}

// Each package, in the lockfile's order, `key` its name in lowercase.
export function planOf(lock, config, folded) {
  return Object.entries(lock.packages).map(([key, pkg]) => {
    const where = about(key)
    const plan = { key, name: pkg.name, version: pkg.version, type: pkg.type, dev: pkg.dev, bin: pkg.bin }
    if (pkg.type === 'metapackage') return { ...plan, path: null }
    return { ...plan, path: installPath(config, pkg, folded, where), from: sourceOf(pkg, config.preference(pkg), where) }
  })
}
