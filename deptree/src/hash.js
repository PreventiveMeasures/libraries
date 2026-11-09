import { toBase64 } from '@exodus/bytes/base64.js'
import { toHex } from '@exodus/bytes/hex.js'
import { utf8fromString } from '@exodus/bytes/utf8.js'
import { DeptreeError } from './error.js'

const digest = async (algorithm, bytes) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes))

// Only well-formed text is hashed: a lone surrogate written as U+FFFD would
// hash two different strings the same.
function utf8(text, where) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new DeptreeError('expected well-formed text to hash', where)
  return utf8fromString(text)
}

export const sha256Hex = async (text, where) => toHex(await digest('SHA-256', utf8(text, where)))

export const sha256Base64 = async (text, where) => toBase64(await digest('SHA-256', utf8(text, where)))

export const matchesIntegrity = async (bytes, integrity) => integrity === `sha512-${toBase64(await digest('SHA-512', bytes))}`

// As yarn 1 records a tarball's after the `#` of its URL.
export const sha1Hex = async (bytes) => toHex(await digest('SHA-1', bytes))

// As soldeer.lock records a zip's checksum.
export const bytesSha256Hex = async (bytes) => toHex(await digest('SHA-256', bytes))
