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
//
// pnpm 12 measures and cuts the name by its UTF-8 bytes, back to where a
// character starts, and takes only an ASCII capital for one; a name not
// all ASCII, as a `file:` path may have, is the only one that tells.

import { quote } from '../error.js'
import { sha256Hex } from '../hash.js'

const HASHED = 33 // `_` and 32 hex characters
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// The name cut to `length` units: UTF-16 ones, or for pnpm 12 bytes.
function cut(filename, length, major) {
  if (major < 12) return filename.slice(0, length)
  const bytes = encoder.encode(filename)
  let end = Math.min(length, bytes.length)
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return decoder.decode(bytes.subarray(0, end))
}

export async function depPathToFilename(depPath, maxLength, major = 10) {
  let filename = depPath.replace(/[\\/:*?"<>|#]/gu, '+')
  if (filename.includes('(')) filename = filename.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  const hashed = filename
  const trailing = major >= 11 ? /[. ]*$/u.exec(filename)[0].length : 0
  if (trailing > 0) filename = `${filename.slice(0, -trailing)}${'+'.repeat(trailing)}`
  const length = major >= 12 ? encoder.encode(filename).length : filename.length
  const lower = major >= 12 ? filename.replace(/[A-Z]+/gu, (capitals) => capitals.toLowerCase()) : filename.toLowerCase()
  if (trailing === 0 && length <= maxLength && filename === lower) return filename
  return `${cut(filename, Math.max(maxLength - HASHED, 0), major)}_${(await sha256Hex(hashed, quote(depPath))).slice(0, 32)}`
}
