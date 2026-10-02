// The directory pnpm gives a snapshot under node_modules/.pnpm, as its
// depPathToFilename (@pnpm/dependency-path) spells it: `a@1.0.0(b@2.0.0)` is
// `a@1.0.0_b@2.0.0`, `@s/a@1.0.0` `@s+a@1.0.0`, and one too long or with a
// capital is cut short and hashed.

import { quote } from '../error.js'
import { md5Base32, sha256Hex } from '../hash.js'

const encoder = new TextEncoder()

// pnpm 12 cuts by bytes, back to where a character starts.
function cut(filename, length, major) {
  if (major < 12) return filename.slice(0, length)
  return filename.slice(0, encoder.encodeInto(filename, new Uint8Array(length)).read)
}

export async function depPathToFilename(depPath, maxLength, major = 10) {
  let filename = depPath.replace(major < 10 ? /[\\/:*?"<>|]/gu : /[\\/:*?"<>|#]/gu, '+')
  if (filename.includes('(')) filename = filename.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  const hashed = filename
  const trailing = major >= 11 ? /[. ]*$/u.exec(filename)[0].length : 0
  if (trailing > 0) filename = `${filename.slice(0, -trailing)}${'+'.repeat(trailing)}`
  const length = major >= 12 ? encoder.encode(filename).length : filename.length
  const lower = major >= 12 ? filename.replace(/[A-Z]+/gu, (capitals) => capitals.toLowerCase()) : filename.toLowerCase()
  if (trailing === 0 && length <= maxLength && filename === lower) return filename
  // By pnpm's createBase32Hash, or createShortHash.
  const hash = `_${major < 10 ? md5Base32(hashed, quote(depPath)) : (await sha256Hex(hashed, quote(depPath))).slice(0, 32)}`
  return `${cut(filename, Math.max(maxLength - hash.length, 0), major)}${hash}`
}
