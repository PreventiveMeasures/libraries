// Refuses a lockfile a frozen install would refuse as out of date with the
// settings (@pnpm/lockfile.settings-checker's getOutdatedLockfileSetting),
// naming the setting as pnpm names it. pnpm 9 holds the lockfile to neither the
// catalogs nor dedupePeers.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, difference, quote } from '../error.js'
import { md5Base32, sha256Hex } from '../hash.js'
import { sameSpecifier } from './frozen.js'
import { catalogEntry } from './overrides.js'
import { checkPatchUse, checkPeerPatches } from './patches.js'

const outdated = (name, detail) => new DeptreeError(`${detail}, which a frozen install refuses`, name)

const SIDES = ['the lockfile', 'the settings']

// `hashes` is { hash, path } by selector, `byHash` { text, path } by hash.
async function hashPatches(configured, given, major) {
  const texts = new Map()
  for (const [key, text] of given) {
    const path = normalize(key)
    if (texts.has(path)) throw new DeptreeError('given twice, under two spellings', `patches[${quote(key)}]`)
    texts.set(path, text)
  }
  const named = new Set()
  const hashes = Object.create(null)
  const byHash = new Map()
  for (const [selector, spec] of Object.entries(configured ?? {})) {
    const path = normalize(spec)
    named.add(path)
    if (!texts.has(path)) throw new DeptreeError(`the patch ${quote(path)} is not given, and pnpm reads every patch it is configured with`, `patchedDependencies[${quote(selector)}]`)
    const text = texts.get(path)
    const normalized = text.replaceAll('\r\n', '\n')
    const where = `patches[${quote(path)}]`
    const hash = major < 10 ? md5Base32(normalized, where) : await sha256Hex(normalized, where)
    hashes[selector] = { hash, path }
    if (!byHash.has(hash)) byHash.set(hash, { text, path })
  }
  for (const path of texts.keys()) {
    if (!named.has(path)) throw new DeptreeError('no patchedDependencies setting names this patch', `patches[${quote(path)}]`)
  }
  return { hashes, byHash }
}

// pnpm 11's lockfile has each patch's hash alone, pnpm 10's its path too.
function checkPatches(locked, hashes, major) {
  const flat = (patches) => Object.fromEntries(Object.entries(patches).map(([selector, { hash, path }]) => [selector, major >= 11 ? hash : `${hash} ${path}`]))
  const detail = difference(flat(locked), flat(hashes), SIDES)
  if (detail !== undefined) throw outdated('patchedDependencies', `the patches differ: ${detail}`)
}

// The lockfile's own settings, the refusal of the first the settings differ
// from, or undefined. An .npmrc can set each of them (settings.js).
export function outdatedSetting(locked, settings, major) {
  if (locked.autoInstallPeers !== undefined && locked.autoInstallPeers !== settings.autoInstallPeers) return outdated('settings.autoInstallPeers', `autoInstallPeers is ${locked.autoInstallPeers} in the lockfile`)
  if (major >= 10 && Boolean(locked.dedupePeers) !== settings.dedupePeers) return outdated('settings.dedupePeers', `dedupePeers is ${Boolean(locked.dedupePeers)} in the lockfile`)
  if ((locked.peersSuffixMaxLength ?? 1000) !== settings.peersSuffixMaxLength) return outdated('settings.peersSuffixMaxLength', `peersSuffixMaxLength is ${locked.peersSuffixMaxLength ?? 'left at 1000'} in the lockfile`)
  return undefined
}

export async function checkUpToDate(lockfile, settings, overrides, given, major) {
  const { hashes, byHash } = await hashPatches(settings.patchedDependencies, given, major)
  for (const [name, catalog] of major < 10 ? [] : Object.entries(lockfile.catalogs)) {
    for (const [alias, { specifier }] of Object.entries(catalog)) {
      const configured = catalogEntry(settings.catalogs, name, alias)
      if (!sameSpecifier(specifier, configured, major)) throw outdated('catalogs', `${quote(alias)} is ${quote(specifier)} in the lockfile's catalog ${quote(name)}, and ${configured === undefined ? 'nothing' : quote(configured)} in the settings`)
    }
  }
  const overridden = difference(lockfile.overrides, Object.fromEntries(overrides.map(({ selector, spec }) => [selector, spec])), SIDES)
  if (overridden !== undefined) throw outdated('overrides', `the overrides differ: ${overridden}`)
  // pnpm checksums them with object-hash, which is not reproduced here.
  if (settings.packageExtensions !== undefined && Object.keys(settings.packageExtensions).length > 0) throw new DeptreeError('package extensions are not supported: their checksum cannot be checked against the lockfile\'s here', 'packageExtensions')
  if (lockfile.packageExtensionsChecksum !== undefined) throw outdated('packageExtensionsChecksum', 'the lockfile was resolved with package extensions, and the settings have none')
  const ignored = (list) => JSON.stringify([...list].sort())
  if (ignored(lockfile.ignoredOptionalDependencies) !== ignored(settings.ignoredOptionalDependencies)) throw outdated('ignoredOptionalDependencies', 'the optional dependencies left out differ')
  checkPatches(lockfile.patchedDependencies, hashes, major)
  const mismatch = outdatedSetting(lockfile.settings, settings, major)
  if (mismatch !== undefined) throw mismatch
  checkPatchUse(lockfile, hashes, major)
  if (major >= 11) checkPeerPatches(lockfile, hashes)
  return byHash
}
