import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pack, packStream, unpack, unpackStream } from '../../tar.js'
import { concat } from '../../src/bytes.js'
import { RECORDINGS, bytesOf } from './fixtures/gnu-tar.js'
import { assertBytes, entriesOf, readable, utf8 } from '../helpers.js'

// The streaming pair say what the in-memory pair say, however the bytes
// are cut, over a plain iterable or an async one.

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

const all = (iterable) => Array.fromAsync(iterable)

describe('unpackStream reads an archive however it is cut', () => {
  for (const recording of RECORDINGS) {
    const bytes = bytesOf(recording)
    for (const size of [1, 7, 511, 512, 513, 1000, 4096, bytes.length]) {
      it(`${recording.command.slice(0, 60)}… in ${size}-byte chunks`, async () => {
        assert.deepEqual(readable(await all(unpackStream(split(bytes, size)))), recording.entries)
      })
    }
  }
  it('takes an async iterable, and empty chunks in its stride', async () => {
    for (const recording of RECORDINGS.slice(0, 6)) {
      const bytes = bytesOf(recording)
      assert.deepEqual(readable(await all(unpackStream(later(split(bytes, 700))))), recording.entries)
    }
    const bytes = pack([{ name: 'a', data: utf8('hi') }])
    assert.equal((await all(unpackStream([new Uint8Array(0), bytes, new Uint8Array(0)]))).length, 1)
  })
  it('copies only the span a header crosses, and views the data in the chunk that brought it', async () => {
    // Were every buffered byte joined to take a header off the boundary, the
    // data behind it would come out of that copy and not out of `rest`.
    const bytes = pack([{ name: 'a', data: utf8('hello') }, { name: 'b', data: utf8('x'.repeat(4000)) }])
    const rest = bytes.subarray(100)
    const [a, b] = await all(unpackStream([bytes.subarray(0, 100), rest]))
    assert.equal(a.data.buffer, rest.buffer)
    assert.equal(b.data.buffer, rest.buffer)
    assert.deepEqual(readable([a, b]), readable(unpack(bytes)))
  })
  it('yields each entry as soon as its bytes are in', async () => {
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
    assert.equal((await entries.next()).value.name, 'a')
    assert.equal(pulled, 2)
    assert.equal((await entries.next()).value.name, 'b')
    assert.equal(pulled, 3)
    assert.equal((await entries.next()).done, true)
    assert.equal(pulled, 5)
  })
  it('refuses what unpack refuses, when it gets there', async () => {
    const bytes = pack([{ name: 'a' }], { blocking: 1 })
    const twice = concat([pack([{ name: 'a', mtime: 1 }], { blocking: 1 }).subarray(0, 512), bytes])
    const entries = unpackStream(split(twice, 512))
    assert.equal((await entries.next()).value.name, 'a')
    await assert.rejects(entries.next(), /duplicate entry "a" differs in mtime at byte 512/u)
    // A stream keeps no data, so a repeat it cannot tell apart is refused
    // there and taken by the in-memory call.
    const same = concat([bytes.subarray(0, 512), bytes])
    await assert.rejects(all(unpackStream([same])), /duplicate entry "a", which only the in-memory call can compare with the earlier one at byte 512/u)
    assert.equal(unpack(same).length, 2)
    await assert.rejects(all(unpackStream([bytes.subarray(0, 512)])), /has no end marker/u)
    await assert.rejects(all(unpackStream([bytes.subarray(0, 1024)])), /ends with a lone zero block/u)
    await assert.rejects(all(unpackStream(later([new Uint8Array(512)]))), /ends with a lone zero block/u)
    await assert.rejects(all(unpackStream(['x'])), /a chunk is not a Uint8Array/u)
    await assert.rejects(all(unpackStream([bytes, utf8('x')])), /data after the end of the archive at byte 1536/u)
    await assert.rejects(all(unpackStream(null)), TypeError)
    assert.equal((await all(unpackStream([bytes, new Uint8Array(1)]))).length, 1)
  })
})

describe('packStream writes an archive a piece at a time', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, async () => {
      assertBytes(concat(await all(packStream(entriesOf(recording), { format: recording.format, blocking: recording.blocking }))), bytesOf(recording))
    })
  }
  it('takes an async iterable', async () => {
    for (const recording of RECORDINGS.slice(0, 6)) {
      const options = { format: recording.format, blocking: recording.blocking }
      assertBytes(concat(await all(packStream(later(entriesOf(recording)), options))), bytesOf(recording))
    }
  })
  it('yields the data it was given, not a copy', async () => {
    const data = utf8('hello')
    const chunks = await all(packStream([{ name: 'a', data }]))
    assert.ok(chunks.includes(data))
  })
  it('refuses an entry when it reaches it, after what came before', async () => {
    const chunks = packStream([{ name: 'a' }, { name: 'a', mode: 0o600 }])
    assert.equal((await chunks.next()).value.length, 512)
    await assert.rejects(chunks.next(), /duplicate entry "a" differs in mode/u)
    await assert.rejects(all(packStream([{ name: 'a' }, { name: 'a' }])), /which only the in-memory call can compare/u)
    assert.equal(unpack(pack([{ name: 'a' }, { name: 'a' }])).length, 2)
    await assert.rejects(all(packStream(later([{ name: '../x' }]))), /has a \.\. segment/u)
    await assert.rejects(all(packStream(null)), TypeError)
  })
  it('agrees with unpack on what unpackStream reads back', async () => {
    const bytes = pack([{ name: 'a', data: utf8('x'.repeat(2000)) }, { name: 'd', type: 'directory' }])
    assert.deepEqual(readable(await all(unpackStream(later(split(bytes, 333))))), readable(unpack(bytes)))
  })
})
