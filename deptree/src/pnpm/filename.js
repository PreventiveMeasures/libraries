// The directory pnpm gives a snapshot under node_modules/.pnpm, as its
// depPathToFilename (@pnpm/dependency-path) spells it: `a@1.0.0(b@2.0.0)` is
// `a@1.0.0_b@2.0.0`, `@s/a@1.0.0` `@s+a@1.0.0`, and one too long or with a
// capital is cut short and hashed.

import { quote } from '../error.js'
import { sha256Hex } from '../hash.js'

const HASHED = 33 // `_` and 32 hex characters
const encoder = new TextEncoder()

// pnpm 12 cuts by bytes, back to where a character starts.
function cut(filename, length, major) {
  if (major < 12) return filename.slice(0, length)
  return filename.slice(0, encoder.encodeInto(filename, new Uint8Array(length)).read)
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
