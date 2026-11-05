// SHA-1 and SHA-256, FIPS 180-4, in lowercase hex: of a Podfile and of a
// Package.swift. Not Web Crypto's, which are asynchronous, as no reader is.

// Whole blocks of big-endian words, the length in bits last.
function pad(bytes) {
  const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16)
  for (let index = 0; index < bytes.length; index++) words[index >>> 2] |= bytes[index] << (24 - (index % 4) * 8)
  words[bytes.length >>> 2] |= 0x80 << (24 - (bytes.length % 4) * 8)
  words[words.length - 2] = Math.floor(bytes.length / 0x20000000)
  words[words.length - 1] = bytes.length * 8
  return words
}

const hex = (state) => Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')

const left = (word, bits) => (word << bits) | (word >>> (32 - bits))
const right = (word, bits) => (word >>> bits) | (word << (32 - bits))

// SHA-1's function of step `t` of `b`, `c` and `d`, and the step's constant.
function round(t, b, c, d) {
  if (t < 20) return ((b & c) | (~b & d)) + 0x5A827999
  if (t < 40) return (b ^ c ^ d) + 0x6ED9EBA1
  if (t < 60) return ((b & c) | (b & d) | (c & d)) + 0x8F1BBCDC
  return (b ^ c ^ d) + 0xCA62C1D6
}

export function sha1Hex(bytes) {
  const words = pad(bytes)
  const state = new Uint32Array([0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0])
  const schedule = new Uint32Array(80)
  for (let block = 0; block < words.length; block += 16) {
    schedule.set(words.subarray(block, block + 16))
    for (let t = 16; t < 80; t++) schedule[t] = left(schedule[t - 3] ^ schedule[t - 8] ^ schedule[t - 14] ^ schedule[t - 16], 1)
    let [a, b, c, d, e] = state
    for (let t = 0; t < 80; t++) {
      const temp = (left(a, 5) + round(t, b, c, d) + e + schedule[t]) >>> 0
      e = d
      d = c
      c = left(b, 30) >>> 0
      b = a
      a = temp
    }
    for (const [index, word] of [a, b, c, d, e].entries()) state[index] += word
  }
  return hex(state)
}

const K = new Uint32Array([
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
])

export function sha256Hex(bytes) {
  const words = pad(bytes)
  const state = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19])
  const w = new Uint32Array(64)
  for (let block = 0; block < words.length; block += 16) {
    w.set(words.subarray(block, block + 16))
    for (let t = 16; t < 64; t++) w[t] = w[t - 16] + (right(w[t - 15], 7) ^ right(w[t - 15], 18) ^ (w[t - 15] >>> 3)) + w[t - 7] + (right(w[t - 2], 17) ^ right(w[t - 2], 19) ^ (w[t - 2] >>> 10))
    let [a, b, c, d, e, f, g, h] = state
    for (let t = 0; t < 64; t++) {
      const t1 = h + (right(e, 6) ^ right(e, 11) ^ right(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]
      const t2 = (right(a, 2) ^ right(a, 13) ^ right(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) state[index] += word
  }
  return hex(state)
}
