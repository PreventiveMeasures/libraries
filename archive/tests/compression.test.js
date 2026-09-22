import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateRawSync, deflateSync, gunzipSync, gzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { ArchiveError, CompressionError, compress, decompress, supports } from '../compression.js'
import { assertBytes, utf8 } from './helpers.js'

// compress() and decompress() are held to what zlib makes of the same
// bytes, to their output bound, and to keeping what came out before a
// failure on the error.

const FORMATS = ['gzip', 'deflate', 'deflate-raw']
const ZLIB = {
  gzip: [gzipSync, gunzipSync],
  deflate: [deflateSync, inflateSync],
  'deflate-raw': [deflateRawSync, inflateRawSync],
}
const text = utf8('alpha beta gamma delta\n'.repeat(10000))
const random = new Uint8Array(65536).map(() => Math.floor(Math.random() * 256))

describe('supports', () => {
  it('knows the formats every runtime has, and not one that none does', () => {
    for (const format of FORMATS) assert.equal(supports(format), true, format)
    assert.equal(supports('nope'), false)
    assert.equal(supports(''), false)
  })
})

describe('compress and decompress', () => {
  for (const format of FORMATS) {
    const [pack, unpack] = ZLIB[format]
    it(`${format}: round-trip, and agree with zlib both ways`, async () => {
      for (const bytes of [new Uint8Array(0), utf8('x'), text, random]) {
        const packed = await compress(bytes, format)
        assertBytes(await decompress(packed, format), bytes)
        assertBytes(new Uint8Array(unpack(packed)), bytes)
        assertBytes(await decompress(new Uint8Array(pack(bytes)), format), bytes)
      }
    })
  }
  it('refuses what is not a Uint8Array', async () => {
    await assert.rejects(compress('text', 'gzip'), (error) => error instanceof ArchiveError && error.message === 'the data is not a Uint8Array')
    await assert.rejects(decompress([1, 2], 'gzip'), /the data is not a Uint8Array/u)
  })
  it('refuses a format the runtime does not have', async () => {
    await assert.rejects(compress(text, 'nope'), TypeError)
    await assert.rejects(decompress(text, 'nope'), TypeError)
  })
})

describe('what decompress refuses', () => {
  it('data that is not the format, with nothing put out', async () => {
    await assert.rejects(decompress(utf8('not gzip at all'), 'gzip'), (error) => {
      assert.ok(error instanceof CompressionError && error instanceof ArchiveError)
      assert.equal(error.message, 'the data does not decompress')
      assert.equal(error.limited, false)
      assert.ok(error.cause instanceof Error)
      assert.deepEqual(error.bytes, new Uint8Array(0))
      return true
    })
  })
  it('a stream cut short, keeping what came out before the cut', async () => {
    const packed = new Uint8Array(gzipSync(text))
    await assert.rejects(decompress(packed.subarray(0, packed.length >> 1), 'gzip'), (error) => {
      assert.equal(error.message, 'the data does not decompress')
      assert.equal(error.limited, false)
      assert.ok(error.bytes.length > 0 && error.bytes.length < text.length, `${error.bytes.length} bytes came out`)
      assertBytes(error.bytes, text.subarray(0, error.bytes.length))
      return true
    })
  })
  // What a runtime had put out before it failed is the runtime's to say:
  // zlib fails the write that met the junk, and with it the member read in
  // that same write. The error still says what it can.
  it('bytes after the end of a member', async () => {
    const packed = new Uint8Array(gzipSync(utf8('alpha\n')))
    await assert.rejects(decompress(new Uint8Array([...packed, 0x4a, 0x55, 0x4e, 0x4b]), 'gzip'), (error) => {
      assert.ok(error instanceof CompressionError)
      assert.equal(error.limited, false)
      assert.ok(error.bytes instanceof Uint8Array && error.bytes.length <= 6)
      return true
    })
  })
})

describe('the output bound', () => {
  it('lets output up to the limit through, and refuses past it where it is', async () => {
    const packed = await compress(text, 'gzip')
    assertBytes(await decompress(packed, 'gzip', { limit: text.length }), text)
    await assert.rejects(decompress(packed, 'gzip', { limit: 1000 }), (error) => {
      assert.ok(error instanceof CompressionError)
      assert.equal(error.message, 'the data decompresses past 1000 bytes')
      assert.equal(error.limited, true)
      assert.ok(error.bytes.length <= 1000)
      assert.ok(error.cause instanceof RangeError)
      return true
    })
    await assert.rejects(decompress(packed, 'gzip', { limit: text.length - 1 }), /decompresses past/u)
  })
  it('bounds compression the same way', async () => {
    const packed = await compress(random, 'gzip')
    await assert.rejects(compress(random, 'gzip', { limit: 100 }), /the data compresses past 100 bytes/u)
    assertBytes(await compress(random, 'gzip', { limit: packed.length }), packed)
  })
})
