// SHA-1, FIPS 180-4, of bytes, in lowercase hex: what CocoaPods checksums
// a Podfile with. Here rather than on Web Crypto, whose digests are all
// asynchronous, where the readers are not.

const rotate = (word, bits) => (word << bits) | (word >>> (32 - bits))

// The message padded to whole blocks, as big-endian words, its length in
// bits last.
function pad(bytes) {
  const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16)
  for (let index = 0; index < bytes.length; index++) words[index >>> 2] |= bytes[index] << (24 - (index % 4) * 8)
  words[bytes.length >>> 2] |= 0x80 << (24 - (bytes.length % 4) * 8)
  words[words.length - 2] = Math.floor(bytes.length / 0x20000000)
  words[words.length - 1] = bytes.length * 8
  return words
}

// The function of step `t` of `b`, `c` and `d`, and the step's constant.
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
    for (let t = 16; t < 80; t++) schedule[t] = rotate(schedule[t - 3] ^ schedule[t - 8] ^ schedule[t - 14] ^ schedule[t - 16], 1)
    let [a, b, c, d, e] = state
    for (let t = 0; t < 80; t++) {
      const temp = (rotate(a, 5) + round(t, b, c, d) + e + schedule[t]) >>> 0
      e = d
      d = c
      c = rotate(b, 30) >>> 0
      b = a
      a = temp
    }
    for (const [index, word] of [a, b, c, d, e].entries()) state[index] += word
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}
