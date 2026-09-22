import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pack, packStream, packStreamAsync, unpack, unpackStream, unpackStreamAsync } from '../index.js'
import { concat } from '../src/header.js'
import { RECORDINGS, bytesOf } from './fixtures/gnu-tar.js'
import { assertBytes, entriesOf, readable, utf8 } from './helpers.js'

// The streaming pair say what the in-memory pair say, however the bytes
// are cut, and the async pair take the same and more.

const split = (bytes, size) => {
  const chunks = []
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size))
  return chunks
}

async function* later(items) {
  for (const item of items) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    yield item
  }
}

const collect = async (iterable) => {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('unpackStream reads an archive however it is cut', () => {
  for (const recording of RECORDINGS) {
    const bytes = bytesOf(recording)
    for (const size of [1, 7, 511, 512, 513, 1000, 4096, bytes.length]) {
      it(`${recording.command.slice(0, 60)}… in ${size}-byte chunks`, () => {
        assert.deepEqual(readable([...unpackStream(split(bytes, size))]), recording.entries)
      })
    }
  }
  it('takes empty chunks in its stride', () => {
    const bytes = pack([{ name: 'a', data: utf8('hi') }])
    assert.equal([...unpackStream([new Uint8Array(0), bytes, new Uint8Array(0)])].length, 1)
  })
  it('yields each entry as soon as its bytes are in', () => {
    const bytes = pack([{ name: 'a', data: utf8('hello') }, { name: 'b' }], { blocking: 1 })
    const chunks = split(bytes, 512)
    let pulled = 0
    const counted = function* counted() {
      for (const chunk of chunks) {
        pulled++
        yield chunk
      }
    }
    const entries = unpackStream(counted())
    assert.equal(entries.next().value.name, 'a')
    assert.equal(pulled, 2)
    assert.equal(entries.next().value.name, 'b')
    assert.equal(pulled, 3)
    assert.equal(entries.next().done, true)
    assert.equal(pulled, 5)
  })
  it('refuses what unpack refuses, when it gets there', () => {
    const bytes = pack([{ name: 'a' }], { blocking: 1 })
    const twice = concat([pack([{ name: 'a', mtime: 1 }], { blocking: 1 }).subarray(0, 512), bytes])
    const entries = unpackStream(split(twice, 512))
    assert.equal(entries.next().value.name, 'a')
    assert.throws(() => entries.next(), /duplicate entry "a" differs in mtime at byte 512/u)
    // A stream keeps no data, so a repeat it cannot tell apart is refused
    // there and taken by the in-memory call.
    const same = concat([bytes.subarray(0, 512), bytes])
    assert.throws(() => [...unpackStream([same])], /duplicate entry "a", which only the in-memory call can compare with the earlier one at byte 512/u)
    assert.equal(unpack(same).length, 2)
    assert.throws(() => [...unpackStream([bytes.subarray(0, 512)])], /has no end marker/u)
    assert.throws(() => [...unpackStream([bytes.subarray(0, 1024)])], /ends with a lone zero block/u)
    assert.throws(() => [...unpackStream(['x'])], /a chunk is not a Uint8Array/u)
    assert.throws(() => [...unpackStream([bytes, utf8('x')])], /data after the end of the archive at byte 1536/u)
    assert.equal([...unpackStream([bytes, new Uint8Array(1)])].length, 1)
  })
})

describe('packStream writes an archive a piece at a time', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, () => {
      assertBytes(concat([...packStream(entriesOf(recording), { format: recording.format, blocking: recording.blocking })]), bytesOf(recording))
    })
  }
  it('yields the data it was given, not a copy', () => {
    const data = utf8('hello')
    const chunks = [...packStream([{ name: 'a', data }])]
    assert.ok(chunks.includes(data))
  })
  it('refuses an entry when it reaches it, after what came before', () => {
    const chunks = packStream([{ name: 'a' }, { name: 'a', mode: 0o600 }])
    assert.equal(chunks.next().value.length, 512)
    assert.throws(() => chunks.next(), /duplicate entry "a" differs in mode/u)
    assert.throws(() => [...packStream([{ name: 'a' }, { name: 'a' }])], /which only the in-memory call can compare/u)
    assert.equal(unpack(pack([{ name: 'a' }, { name: 'a' }])).length, 2)
  })
})

describe('the async pair', () => {
  it('take async iterables, and plain ones', async () => {
    for (const recording of RECORDINGS.slice(0, 6)) {
      const entries = entriesOf(recording)
      const options = { format: recording.format, blocking: recording.blocking }
      const bytes = bytesOf(recording)
      assertBytes(concat(await collect(packStreamAsync(later(entries), options))), bytes)
      assertBytes(concat(await collect(packStreamAsync(entries, options))), bytes)
      assert.deepEqual(readable(await collect(unpackStreamAsync(later(split(bytes, 700))))), recording.entries)
      assert.deepEqual(readable(await collect(unpackStreamAsync(split(bytes, 700)))), recording.entries)
    }
  })
  it('refuse what the others refuse', async () => {
    await assert.rejects(collect(packStreamAsync(later([{ name: '../x' }]))), /has a \.\. segment/u)
    await assert.rejects(collect(unpackStreamAsync(later([new Uint8Array(512)]))), /ends with a lone zero block/u)
    await assert.rejects(collect(packStreamAsync(null)), TypeError)
  })
  it('agree with unpack on what they read', async () => {
    const bytes = pack([{ name: 'a', data: utf8('x'.repeat(2000)) }, { name: 'd', type: 'directory' }])
    assert.deepEqual(readable(await collect(unpackStreamAsync(later(split(bytes, 333))))), readable(unpack(bytes)))
  })
})
