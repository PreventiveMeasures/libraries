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

// As gzip(1) and zlib read it: zeros after the last member are padding.
describe('gzip padding', () => {
  const zeros = (length) => new Uint8Array(length)
  const join = (...parts) => new Uint8Array(parts.flatMap((part) => [...part]))
  it('is passed over, wherever the last member ends past its last byte that is not zero', async () => {
    // Lengths whose last four bytes, the length's, end in zero to three zeros.
    for (const length of [0, 1, 255, 256, 512, 30720, 65536, 65537, 2 ** 24]) {
      const bytes = text.length >= length ? text.subarray(0, length) : new Uint8Array(length).fill(0x61)
      const packed = new Uint8Array(gzipSync(bytes))
      for (const padding of [1, 3, 10240 - (packed.length % 10240)]) {
        assertBytes(await decompress(join(packed, zeros(padding)), 'gzip'), bytes, `${length} bytes, ${padding} zeros after`)
      }
    }
  })
  it('after several members, and after an empty one as zlib writes it', async () => {
    const empty = new Uint8Array(gzipSync(new Uint8Array(0)))
    assert.deepEqual([...empty.subarray(-10)], [3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const a = utf8('alpha\n')
    assertBytes(await decompress(join(gzipSync(a), gzipSync(text), zeros(512)), 'gzip'), join(a, text))
    assertBytes(await decompress(join(gzipSync(a), empty, zeros(1)), 'gzip'), a)
  })
  it('and nothing else: not what follows a zero, as zlib passes over, nor zeros after a stream that is not whole', async () => {
    const packed = new Uint8Array(gzipSync(text))
    for (const tail of [[0, 1, 0], [1, 0, 0], [0x1f, 0x8b, 0], [0, ...packed, 0]]) {
      await assert.rejects(decompress(join(packed, tail), 'gzip'), (error) => error instanceof CompressionError && error.message === 'the data does not decompress' && !error.limited)
    }
    const corrupt = packed.slice()
    corrupt[packed.length - 8] ^= 1
    // Its last byte is a zero, the length's highest: cut with the one before it.
    assert.deepEqual([...packed.subarray(-2)], [3, 0])
    for (const cut of [corrupt, packed.subarray(0, packed.length >> 1), packed.subarray(0, packed.length - 2)]) {
      await assert.rejects(decompress(join(cut, zeros(2)), 'gzip'), /the data does not decompress/u)
    }
    await assert.rejects(decompress(zeros(16), 'gzip'), /the data does not decompress/u)
  })
  it('in gzip alone', async () => {
    for (const format of ['deflate', 'deflate-raw']) {
      await assert.rejects(decompress(join(ZLIB[format][0](text), zeros(4)), format), /the data does not decompress/u, format)
    }
  })
  it('bounds what it gives the same way', async () => {
    const padded = join(gzipSync(text), zeros(100))
    assertBytes(await decompress(padded, 'gzip', { limit: text.length }), text)
    await assert.rejects(decompress(padded, 'gzip', { limit: text.length - 1 }), (error) => error instanceof CompressionError && error.limited && error.message === `the data decompresses past ${text.length - 1} bytes`)
  })
})

// gzip's trailer says how much its last member decompresses to: the output
// is made into one array that size as it comes, where the trailer is to be
// believed, and is the same where it is not.
describe('gzip output sized by its trailer', () => {
  const join = (...parts) => new Uint8Array(parts.flatMap((part) => [...part]))
  it('is one array, the size of the output, for one member', async () => {
    const out = await decompress(new Uint8Array(gzipSync(text)), 'gzip')
    assertBytes(out, text)
    assert.equal(out.buffer.byteLength, text.length, 'no array joined from pieces, nor room to spare')
  })
  it('is all of it where the last member says less than all of it is', async () => {
    const a = utf8('alpha\n'.repeat(1000))
    assertBytes(await decompress(join(gzipSync(text), gzipSync(a)), 'gzip'), join(text, a))
  })
  it('is refused as before where the trailer says other than the member makes, keeping what came out', async () => {
    const packed = new Uint8Array(gzipSync(text))
    const view = new DataView(packed.buffer, packed.byteOffset)
    for (const said of [text.length + 1, text.length - 1, 0xffffffff]) {
      const forged = packed.slice()
      new DataView(forged.buffer).setUint32(forged.length - 4, said, true)
      await assert.rejects(decompress(forged, 'gzip'), (error) => {
        assert.ok(error instanceof CompressionError && !error.limited, String(said))
        assert.equal(error.message, 'the data does not decompress')
        assertBytes(error.bytes, text.subarray(0, error.bytes.length))
        return true
      })
    }
    assert.equal(view.getUint32(packed.length - 4, true), text.length)
  })
  // What the output is made into, in the arrays decompress makes of a size.
  const allocated = async (run) => {
    const sizes = []
    const native = globalThis.Uint8Array
    globalThis.Uint8Array = new Proxy(native, {
      construct(target, args, newTarget) {
        if (typeof args[0] === 'number') sizes.push(args[0])
        return Reflect.construct(target, args, newTarget)
      },
    })
    try {
      await run()
    } finally {
      globalThis.Uint8Array = native
    }
    return Math.max(0, ...sizes)
  }
  it('of no more than the trailer of the data as given, and none of the places padding is tried ending at', async () => {
    // Incompressible: the places tried before the member's end have its checksum where a trailer would be.
    const noise = new Uint8Array(1 << 20).map(() => Math.floor(Math.random() * 256))
    const packed = new Uint8Array(gzipSync(noise))
    const padded = join(packed, new Uint8Array(10240 - (packed.length % 10240)))
    let out
    const most = await allocated(async () => {
      out = await decompress(padded, 'gzip')
    })
    assertBytes(out, noise)
    assert.ok(most <= packed.length * 2, `${most} bytes allocated at once for ${padded.length} in`)
  })
  it('of no more than sixteen times the data, whatever the trailer says', async () => {
    const forged = new Uint8Array(gzipSync(text))
    // More than comes out, and than sixteen times the data, though deflate could make that much.
    const said = text.length + 4096
    assert.ok(said > forged.length * 16 && said < forged.length * 1032)
    new DataView(forged.buffer).setUint32(forged.length - 4, said, true)
    const most = await allocated(() => assert.rejects(decompress(forged, 'gzip'), /the data does not decompress/u))
    assert.ok(most < said, `${most} bytes allocated at once, the trailer saying ${said}`)
  })
  it('within the limit alone', async () => {
    const packed = new Uint8Array(gzipSync(text))
    await assert.rejects(decompress(packed, 'gzip', { limit: text.length - 1 }), (error) => error.limited && error.bytes.length <= text.length - 1)
    assertBytes(await decompress(packed, 'gzip', { limit: text.length }), text)
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
  it('takes a bound that is no number as refusing everything, not nothing', async () => {
    const packed = await compress(text, 'gzip')
    for (const limit of [Number.NaN, -1, undefined]) {
      if (limit === undefined) assertBytes(await decompress(packed, 'gzip', { limit }), text)
      else await assert.rejects(decompress(packed, 'gzip', { limit }), (error) => error instanceof CompressionError && error.limited && error.bytes.length === 0)
    }
    assertBytes(await decompress(await compress(new Uint8Array(0), 'gzip'), 'gzip', { limit: 0 }), new Uint8Array(0))
  })
  it('bounds compression the same way', async () => {
    const packed = await compress(random, 'gzip')
    await assert.rejects(compress(random, 'gzip', { limit: 100 }), /the data compresses past 100 bytes/u)
    assertBytes(await compress(random, 'gzip', { limit: packed.length }), packed)
  })
})
