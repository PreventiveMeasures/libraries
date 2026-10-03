// MD5, RFC 1321, of a string of ASCII, which Composer's content-hash is of
// what json_encode writes with no flags: nothing past ASCII is left in it.

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

function words(text) {
  const length = text.length
  const blocks = Math.ceil((length + 9) / 64)
  const bytes = new Uint8Array(blocks * 64)
  for (let i = 0; i < length; i++) bytes[i] = text.codePointAt(i)
  bytes[length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(bytes.length - 8, (length * 8) >>> 0, true)
  view.setUint32(bytes.length - 4, Math.floor((length * 8) / 2 ** 32), true)
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true))
}

const rotate = (value, by) => ((value << by) | (value >>> (32 - by))) >>> 0

export function md5(text) {
  if (/[^\0-\u007F]/u.test(text)) throw new TypeError('expected ASCII')
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  const input = words(text)
  for (let block = 0; block < input.length; block += 16) {
    let [a, b, c, d] = state
    for (let i = 0; i < 64; i++) {
      const round = i >> 4
      const f = [(b & c) | (~b & d), (d & b) | (~d & c), b ^ c ^ d, c ^ (b | ~d)][round]
      const g = [i, 5 * i + 1, 3 * i + 5, 7 * i][round] % 16
      const next = (b + rotate((a + f + K[i] + input[block + g]) >>> 0, SHIFTS[round * 4 + (i % 4)])) >>> 0
      ;[a, b, c, d] = [d, next, b, c]
    }
    for (const [index, word] of [a, b, c, d].entries()) state[index] = (state[index] + word) >>> 0
  }
  return state.map((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('')
}
