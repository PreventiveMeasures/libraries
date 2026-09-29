// Digests on the platform's Web Crypto, which every runtime this runs on
// has: the integrity a lockfile pins a tarball to, and the hex digests
// pnpm names a patch and a long directory by.

import { DeptreeError } from './error.js'

const encoder = new TextEncoder()
const ALGORITHMS = { __proto__: null, sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }

const digest = async (algorithm, bytes) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const base64 = (bytes) => btoa(String.fromCodePoint(...bytes))

// Text is hashed as its UTF-8, and only text that has one: TextEncoder
// writes a lone surrogate as U+FFFD, so two different strings would hash
// the same. `where` is what the text is, for the refusal.
export async function sha256Hex(text, where) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new DeptreeError('expected well-formed text to hash', where)
  return hex(await digest('SHA-256', encoder.encode(text)))
}

// Whether `bytes` are what a subresource integrity of one hash names, as
// the lockfile reader has already held it to: an algorithm, a dash, and
// the digest in padded base64.
export async function matchesIntegrity(bytes, integrity) {
  const dash = integrity.indexOf('-')
  const algorithm = ALGORITHMS[integrity.slice(0, dash)]
  if (algorithm === undefined) return false
  return base64(await digest(algorithm, bytes)) === integrity.slice(dash + 1)
}
