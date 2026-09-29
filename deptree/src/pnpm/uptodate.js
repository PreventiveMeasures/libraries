// Whether the lockfile is the one pnpm 10 would install as it is. Before a
// frozen install pnpm holds it to the settings that shaped its resolution
// (@pnpm/lockfile.settings-checker's getOutdatedLockfileSetting): the
// catalogs, the overrides, the package extensions' checksum, the optional
// dependencies left out, the patches, and a few of its own settings. Where
// one differs, `--frozen-lockfile` refuses to install, and so does this,
// naming the setting as pnpm names it. An install here is always frozen.
//
// The patches are hashed here, all of them, as pnpm reads every one it is
// configured with, whether or not a package installed uses it; each has to
// be given, by the path the settings name it by, and nothing else may be.
// Only one a package installed uses is read as a patch, where it is
// applied, as pnpm reads it.

import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, difference, quote } from '../error.js'
import { sha256Hex } from '../hash.js'
import { checkPatchUse } from './patches.js'

const outdated = (name, detail) => new DeptreeError(`${detail}, which a frozen install refuses`, name)

const SIDES = ['the lockfile', 'the settings']

// By selector, the hash and path pnpm computes of each configured patch,
// and by hash, the patch's text and path. `given` is the files by path.
async function hashPatches(configured, given) {
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
    const hash = await sha256Hex(text.replaceAll('\r\n', '\n'), `patches[${quote(path)}]`)
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

// Throws where pnpm would not install the lockfile as it is; hands back the
// patches by hash, their text and path, to apply where a snapshot names one.
// `overrides` is listOverrides's.
export async function checkUpToDate(lockfile, settings, overrides, given, major = 10) {
  const { hashes, byHash } = await hashPatches(settings.patchedDependencies, given)
  for (const [name, catalog] of Object.entries(lockfile.catalogs)) {
    for (const [alias, { specifier }] of Object.entries(catalog)) {
      const configured = settings.catalogs[name]?.[alias]
      if (specifier !== configured) throw outdated('catalogs', `${quote(alias)} is ${quote(specifier)} in the lockfile's catalog ${quote(name)}, and ${configured === undefined ? 'nothing' : quote(configured)} in the settings`)
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
  const locked = lockfile.settings
  if (locked.autoInstallPeers !== undefined && locked.autoInstallPeers !== settings.autoInstallPeers) throw outdated('settings.autoInstallPeers', `autoInstallPeers is ${locked.autoInstallPeers} in the lockfile`)
  if (Boolean(locked.dedupePeers) !== settings.dedupePeers) throw outdated('settings.dedupePeers', `dedupePeers is ${Boolean(locked.dedupePeers)} in the lockfile`)
  if ((locked.peersSuffixMaxLength ?? 1000) !== settings.peersSuffixMaxLength) throw outdated('settings.peersSuffixMaxLength', `peersSuffixMaxLength is ${locked.peersSuffixMaxLength ?? 'left at 1000'} in the lockfile`)
  checkPatchUse(lockfile, hashes)
  return byHash
}
