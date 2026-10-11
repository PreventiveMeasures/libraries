import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'node:test'
import { sameBytes as portable } from '../src/same-bytes.js'
import { sameBytes as node } from '../src/same-bytes.node.js'

// Both of the twins, as each runs where it is picked: the same answer as
// byte by byte, at any length, with each array starting anywhere in a word.

const reference = (x, y) => x.length === y.length && x.every((byte, i) => byte === y[i])
const at = (bytes, offset, Type = Uint8Array) => {
  const copy = new Type(bytes.length + offset)
  copy.set(bytes, offset)
  return copy.subarray(offset)
}
const LENGTHS = [0, 1, 3, 4, 5, 31, 32, 33, 35, 36, 63, 64, 100, 1027, 4099]

describe('sameBytes', () => {
  it('is picked for Node by package.json imports', () => {
    assert.ok(import.meta.resolve('#same-bytes').endsWith('/src/same-bytes.node.js'))
  })

  for (const [name, sameBytes] of [['portable', portable], ['node', node]]) {
    describe(name, () => {
      it('takes the same bytes as the same, from any offset', () => {
        for (const n of LENGTHS) {
          const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xFF)
          for (let a = 0; a < 4; a++) {
            for (let b = 0; b < 4; b++) assert.equal(sameBytes(at(bytes, a), at(bytes, b)), true, `${n} bytes at ${a} and ${b}`)
          }
        }
      })

      it('tells a byte changed anywhere, before, in or after the words', () => {
        for (const n of LENGTHS.filter((length) => length > 0)) {
          const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xFF)
          for (const i of new Set([0, 1, 2, 3, 4, n >> 1, n - 4, n - 3, n - 2, n - 1].filter((index) => index >= 0 && index < n))) {
            const other = bytes.slice()
            other[i] ^= 0x80
            for (let a = 0; a < 4; a++) {
              assert.equal(sameBytes(at(bytes, a), at(other, a)), false, `${n} bytes, byte ${i}, both at ${a}`)
              assert.equal(sameBytes(at(other, 0), at(bytes, a)), false, `${n} bytes, byte ${i}, at 0 and ${a}`)
            }
          }
        }
      })

      it('tells lengths apart, a prefix included', () => {
        const bytes = new Uint8Array(64).fill(7)
        assert.equal(sameBytes(bytes, bytes.subarray(0, 63)), false)
        assert.equal(sameBytes(bytes.subarray(0, 0), new Uint8Array(1)), false)
      })

      it('takes a Buffer, a shared buffer and a growable one alike', () => {
        const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)
        const growable = new Uint8Array(new ArrayBuffer(101, { maxByteLength: 200 }), 1, 100)
        growable.set(bytes)
        for (const other of [Buffer.from(bytes), at(bytes, 1, Buffer), new Uint8Array(new SharedArrayBuffer(100)).fill(0), growable]) {
          assert.equal(sameBytes(bytes, other), reference(bytes, other), other.constructor.name)
          assert.equal(sameBytes(other, bytes), reference(bytes, other), other.constructor.name)
        }
      })

      it('agrees with byte by byte on arrays that mostly match', () => {
        let seed = 1
        const random = () => (seed = Math.imul(seed, 48271) % 0x7FFFFFFF) & 0xFF
        for (let round = 0; round < 500; round++) {
          const n = random() * (round % 3 === 0 ? 17 : 1)
          const x = at(Uint8Array.from({ length: n }, random), random() & 3)
          const y = at(x, random() & 3)
          if (n > 0 && random() < 128) y[random() % n] ^= 1 + (random() % 255)
          assert.equal(sameBytes(x, y), reference(x, y), `round ${round}`)
        }
      })
    })
  }
})
