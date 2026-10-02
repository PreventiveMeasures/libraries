import { DeptreeError } from './error.js'

const encoder = new TextEncoder()

const digest = async (algorithm, bytes) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const base64 = (bytes) => btoa(String.fromCodePoint(...bytes))

// Only well-formed text is hashed: TextEncoder writes a lone surrogate as
// U+FFFD, so two different strings would hash the same.
function utf8(text, where) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new DeptreeError('expected well-formed text to hash', where)
  return encoder.encode(text)
}

export const sha256Hex = async (text, where) => hex(await digest('SHA-256', utf8(text, where)))

// MD5, which Web Crypto has not, as RFC 1321 has it.
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
function md5(input) {
  const blocks = Math.ceil((input.length + 9) / 64)
  const padded = new Uint8Array(blocks * 64)
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
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
  }
  const bytes = new Uint8Array(16)
  const out = new DataView(bytes.buffer)
  state.forEach((word, i) => out.setUint32(i * 4, word, true))
  return bytes
}

// RFC 4648's base32, lowercased and unpadded.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(bytes) {
  let text = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += BASE32[(value >>> bits) & 31]
    }
  }
  return bits > 0 ? text + BASE32[(value << (5 - bits)) & 31] : text
}

// pnpm 9's createBase32Hash: the MD5 of the text's UTF-8, in base32.
export const md5Base32 = (text, where) => base32(md5(utf8(text, where)))

export const matchesIntegrity = async (bytes, integrity) => integrity === `sha512-${base64(await digest('SHA-512', bytes))}`

// As yarn 1 records a tarball's after the `#` of its URL.
export const sha1Hex = async (bytes) => hex(await digest('SHA-1', bytes))

// As soldeer.lock records a zip's checksum.
export const bytesSha256Hex = async (bytes) => hex(await digest('SHA-256', bytes))
