import assert from 'node:assert/strict'
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { unzip, unzipStream, zip } from '../../zip.js'
import { view } from '../../src/zip/format.js'
import { RECORDINGS, bytesOf } from './fixtures/info-zip.js'
import { readable, utf8 } from '../helpers.js'

// unzipStream() says what unzip() says, over the archive in memory or a
// Blob, and reads no more of a Blob at a time than a chunk of its records
// or the entry it is on.

const all = (iterable) => Array.fromAsync(iterable)

// A Blob that notes the length of every range read from it, and can be
// made to come back short once the layout has been read.
class Watched extends Blob {
  reads = []
  short = false
  slice(from, to) {
    this.reads.push(to - from)
    return super.slice(from, this.short && to - from > 1000 ? to - 1 : to)
  }
}

describe('unzipStream reads what unzip reads', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, async () => {
      const bytes = bytesOf(recording)
      assert.deepEqual(readable(await all(unzipStream(bytes))), recording.entries)
      assert.deepEqual(readable(await all(unzipStream(new Blob([bytes])))), recording.entries)
      const stored = (entries) => entries.map((entry) => entry.storedName)
      assert.deepEqual(stored(await all(unzipStream(new Blob([bytes])))), stored(await unzip(bytes)))
    })
  }
  it('from a file, through fs.openAsBlob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzip-stream-'))
    try {
      const file = join(dir, 'a.zip')
      writeFileSync(file, bytesOf(RECORDINGS[0]))
      assert.deepEqual(readable(await all(unzipStream(await openAsBlob(file)))), RECORDINGS[0].entries)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
  it('hands out data of its own from a Blob, and views of the archive from bytes', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('hello') }], { method: 'store' })
    const [fromBlob] = await all(unzipStream(new Blob([bytes])))
    assert.equal(fromBlob.data.buffer.byteLength, fromBlob.data.length)
    const [fromBytes] = await all(unzipStream(bytes))
    assert.equal(fromBytes.data.buffer, bytes.buffer)
  })
})

describe('unzipStream reads an entry only when it reaches it', () => {
  it('reads each entry\'s data as it hands that entry out, and not before', async () => {
    const data = new Uint8Array(100_000).fill(0x61)
    const blob = new Watched([await zip([{ name: 'a', data }, { name: 'b', data }], { method: 'store' })])
    const big = () => blob.reads.filter((length) => length >= data.length).length
    const entries = unzipStream(blob)
    assert.equal((await entries.next()).value.name, 'a')
    assert.equal(big(), 1)
    assert.equal((await entries.next()).value.name, 'b')
    assert.equal(big(), 2)
    assert.equal((await entries.next()).done, true)
  })
  it('checks the local headers without reading the data after each', async () => {
    const data = new Uint8Array(70_000).fill(0x61)
    const blob = new Watched([await zip(Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, data })), { method: 'store' })])
    const entries = unzipStream(blob)
    assert.equal((await entries.next()).value.name, 'f0')
    // The search for the end record reaches back 64 KiB, and f0's data is
    // read to hand it out; past those two, headers alone.
    const read = blob.reads.reduce((sum, length) => sum + length, 0)
    assert.ok(read < 3 * data.length, `${read} bytes read`)
  })
  it('reads a central directory a chunk at a time, however large', async () => {
    const names = Array.from({ length: 3000 }, (_, i) => `a-rather-long-name-for-entry-${i}`)
    const bytes = await zip(names.map((name) => ({ name })))
    const size = view(bytes).getUint32(bytes.length - 22 + 12, true)
    const blob = new Watched([bytes])
    assert.deepEqual((await all(unzipStream(blob))).map((entry) => entry.name), names)
    assert.ok(Math.max(...blob.reads) < size)
  })
})

describe('what unzipStream refuses', () => {
  it('what the layout gets wrong, before handing out any entry', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('x') }, { name: 'b', data: utf8('y') }])
    const entries = unzipStream(bytes.with(0, 0))
    await assert.rejects(entries.next(), /no local header where the central directory points at byte 0/u)
    await assert.rejects(all(unzipStream(new Uint8Array(21))), /no end of central directory record/u)
  })
  it('what an entry holds, when it reaches it, after the entries before', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('x') }, { name: 'b', data: utf8('y') }], { method: 'store' })
    // The last byte before the central directory is b's data.
    const start = view(bytes).getUint32(bytes.length - 22 + 16, true)
    const entries = unzipStream(bytes.with(start - 1, 0x7a))
    assert.equal((await entries.next()).value.name, 'a')
    await assert.rejects(entries.next(), /the data does not match its CRC-32/u)
  })
  it('past the limit, before any entry', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('xy') }])
    await assert.rejects(unzipStream(bytes, { limit: 1 }).next(), /the entries come to more than 1 bytes/u)
    assert.equal((await all(unzipStream(bytes, { limit: 2 }))).length, 1)
  })
  it('a name again as the same entry, which only the in-memory call can compare', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('x') }, { name: 'a', data: utf8('x') }])
    assert.equal((await unzip(bytes)).length, 2)
    await assert.rejects(all(unzipStream(bytes)), /duplicate entry "a", which only the in-memory call can compare with the earlier one/u)
  })
  it('an archive that is neither bytes nor a Blob', async () => {
    for (const archive of ['zip', null, [1, 2], new ArrayBuffer(22)]) {
      await assert.rejects(unzipStream(archive).next(), /the archive is not a Uint8Array or a Blob/u)
    }
  })
  it('a Blob that comes back shorter than its layout said', async () => {
    const blob = new Watched([await zip([{ name: 'a', data: new Uint8Array(5000).fill(1) }], { method: 'store' })])
    const entries = unzipStream(blob)
    // Only the data is a read of more than a thousand bytes, and it comes
    // back a byte short of what the layout, read already, said it was.
    const pending = entries.next()
    blob.short = true
    await assert.rejects(pending, /the archive is truncated at byte 40/u)
  })
})
