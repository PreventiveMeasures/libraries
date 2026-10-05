import { toBase32 } from '@exodus/bytes/base32.js'
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

// MD5, which Web Crypto has not, as RFC 1321 has it.
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
function md5(input) {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (input.length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(input.length / 2 ** 29), true)
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  for (let block = 0; block < padded.length; block += 64) {
    let [a, b, c, d] = state
    for (let i = 0; i < 64; i++) {
      const round = i >> 4
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d)
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16
      const shift = SHIFTS[round * 4 + (i % 4)]
      const sum = (a + f + SINES[i] + view.getUint32(block + g * 4, true)) >>> 0
      ;[a, d, c] = [d, c, b]
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0
    }
    for (const [i, word] of [a, b, c, d].entries()) state[i] = (state[i] + word) >>> 0
  }
  const bytes = new Uint8Array(16)
  const out = new DataView(bytes.buffer)
  state.forEach((word, i) => out.setUint32(i * 4, word, true))
  return bytes
}

// pnpm 9's createBase32Hash: the MD5 of the text's UTF-8, in RFC 4648's
// base32, lowercased and unpadded.
export const md5Base32 = (text, where) => toBase32(md5(utf8(text, where)), { padding: false }).toLowerCase()

export const matchesIntegrity = async (bytes, integrity) => integrity === `sha512-${toBase64(await digest('SHA-512', bytes))}`

// As yarn 1 records a tarball's after the `#` of its URL.
export const sha1Hex = async (bytes) => toHex(await digest('SHA-1', bytes))

// As soldeer.lock records a zip's checksum.
export const bytesSha256Hex = async (bytes) => toHex(await digest('SHA-256', bytes))

// The CRC-32 a gzip trailer records, as ISO 3309 has it.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
