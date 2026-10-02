// Digests on Web Crypto, which every runtime this runs on has.

import { DeptreeError } from './error.js'

const encoder = new TextEncoder()

const digest = async (algorithm, bytes) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const base64 = (bytes) => btoa(String.fromCodePoint(...bytes))

// Only well-formed text is hashed: TextEncoder writes a lone surrogate as
// U+FFFD, so two different strings would hash the same.
export async function sha256Hex(text, where) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new DeptreeError('expected well-formed text to hash', where)
  return hex(await digest('SHA-256', encoder.encode(text)))
}

// Only a sha512 integrity, in padded base64, is taken.
export const matchesIntegrity = async (bytes, integrity) => integrity === `sha512-${base64(await digest('SHA-512', bytes))}`

// As yarn 1 records a tarball's after the `#` of its URL.
export const sha1Hex = async (bytes) => hex(await digest('SHA-1', bytes))
