// The directory pnpm 10 gives a snapshot under node_modules/.pnpm, as its
// depPathToFilename (@pnpm/dependency-path) spells it: the snapshot key
// with each character a filesystem may refuse made `+`, the parentheses of
// the peers and the patch made `_` and the last one dropped, and, where
// that runs past `virtualStoreDirMaxLength` or has a capital in it, cut
// short and ended with `_` and 32 hex characters of its SHA-256.
// `a@1.0.0(b@2.0.0)` is `a@1.0.0_b@2.0.0`, `@s/a@1.0.0` `@s+a@1.0.0`.
//
// pnpm 11 escapes a trailing dot or space as well, each made `+`, and then
// hashes the name whatever its length; a snapshot of the registry never
// ends in either. pnpm 9 hashed with MD5 in base32, which is not done here.

import { quote } from '../error.js'
import { sha256Hex } from '../hash.js'

const HASHED = 33 // `_` and 32 hex characters

export async function depPathToFilename(depPath, maxLength, major = 10) {
  let filename = depPath.replace(/[\\/:*?"<>|#]/gu, '+')
  if (filename.includes('(')) filename = filename.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  const hashed = filename
  const trailing = major >= 11 ? /[. ]*$/u.exec(filename)[0].length : 0
  if (trailing > 0) filename = `${filename.slice(0, -trailing)}${'+'.repeat(trailing)}`
  if (trailing === 0 && filename.length <= maxLength && filename === filename.toLowerCase()) return filename
  return `${filename.slice(0, Math.max(maxLength - HASHED, 0))}_${(await sha256Hex(hashed, quote(depPath))).slice(0, 32)}`
}
