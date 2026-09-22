import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError, unzip, zip } from '../../zip.js'
import { view } from '../../src/zip/format.js'
import { readable, utf8 } from '../helpers.js'

// zip() is held to reading back as what it was given, to the layout a zip
// has, and to refusing what an archive could not say truthfully.

const T = 1577836800
const ENTRIES = [
  { name: 'a.txt', type: 'file', mode: 0o644, mtime: T, linkname: '', data: utf8('hello hello hello hello\n') },
  { name: 'dir', type: 'directory', mode: 0o755, mtime: T, linkname: '', data: new Uint8Array(0) },
  { name: 'dir/b.bin', type: 'file', mode: 0o600, mtime: T + 1, linkname: '', data: new Uint8Array(3000).fill(0x62) },
  { name: 'empty', type: 'file', mode: 0o644, mtime: 315532800, linkname: '', data: new Uint8Array(0) },
  { name: 'link', type: 'symlink', mode: 0o777, mtime: T, linkname: 'a.txt', data: new Uint8Array(0) },
  { name: 'ü.txt', type: 'file', mode: 0o644, mtime: T, linkname: '', data: utf8('x') },
  { name: 'last', type: 'file', mode: 0o644, mtime: 0x7fffffff, linkname: '', data: utf8('2038') },
]

const methodAt = (bytes, offset) => view(bytes).getUint16(offset + 8, true)

describe('zip reads back as what it was given', () => {
  for (const method of ['deflate', 'store']) {
    it(`under ${method}`, async () => {
      const bytes = await zip(ENTRIES, { method })
      assert.deepEqual(readable(await unzip(bytes)), readable(ENTRIES))
    })
  }
  it('fills in what an entry leaves out', async () => {
    const [file, dir, link] = await unzip(await zip([{ name: 'a' }, { name: 'd/', type: 'directory' }, { name: 'l', type: 'symlink', linkname: 'a' }]))
    assert.deepEqual([file.mode, dir.mode, link.mode], [0o644, 0o755, 0o777])
    assert.deepEqual([file.mtime, file.linkname, file.data.length, dir.name], [315532800, '', 0, 'd'])
  })
  it('lays the archive out as a zip: local entries from byte 0, the end record last', async () => {
    const bytes = await zip([{ name: 'a', data: utf8('x') }])
    assert.equal(view(bytes).getUint32(0, true), 0x04034b50)
    assert.equal(view(bytes).getUint32(bytes.length - 22, true), 0x06054b50)
    assert.equal((await zip([])).length, 22)
  })
  it('deflates a file only where that is smaller, and never a directory or symlink', async () => {
    const bytes = await zip([{ name: 'small', data: utf8('x') }, { name: 'big', data: new Uint8Array(3000).fill(0x62) }, { name: 'd', type: 'directory' }])
    assert.equal(methodAt(bytes, 0), 0)
    const second = 30 + 5 + 9 + 1
    assert.equal(methodAt(bytes, second), 8)
    assert.ok(bytes.length < 3000)
    assert.equal(methodAt(await zip([{ name: 'big', data: new Uint8Array(3000).fill(0x62) }], { method: 'store' }), 0), 0)
  })
  it('takes a name again as the same entry, and cleans names', async () => {
    const entries = await unzip(await zip([{ name: './d/f', data: utf8('x') }, { name: 'd/./f', data: utf8('x') }, { name: 'd/', type: 'directory' }]))
    assert.deepEqual(entries.map((e) => e.name), ['d/f', 'd/f', 'd'])
  })
})

describe('what it refuses', () => {
  const refused = [
    [[null], /an entry is not an object/u],
    [[{}], /entry name is not a string/u],
    [[{ name: 'a', type: 'fifo' }], /entry type "fifo" is not one this package writes/u],
    [[{ name: 'a', type: { toString: () => 'directory' } }], /entry type is not a string/u],
    [[{ name: 'a', data: 'x' }], /data of "a" is not a Uint8Array/u],
    [[{ name: 'd', type: 'directory', data: utf8('x') }], /a directory cannot carry data/u],
    [[{ name: 'a', linkname: 'b' }], /a file cannot have a link target/u],
    [[{ name: 'l', type: 'symlink' }], /symlink target of "l" is empty/u],
    [[{ name: 'l', type: 'symlink', linkname: '../x' }], /points outside the archive/u],
    [[{ name: 'a\uD800' }], /entry name is not well-formed Unicode/u],
    [[{ name: 'l', type: 'symlink', linkname: 'x\uDC00' }], /link target of "l" is not well-formed Unicode/u],
    [[{ name: 'a', mode: 0o100644 }], /mode 33188 is not an integer from 0 to 4095/u],
    [[{ name: 'a', mtime: 315532799 }], /mtime 315532799 is not an integer from 315532800 to 2147483647/u],
    [[{ name: 'a', mtime: 0x80000000 }], /mtime 2147483648 is not an integer/u],
    [[{ name: 'a', mtime: 1.5 }], /mtime 1\.5 is not an integer/u],
    [[{ name: 'a/' }], /ends in a slash but is not a directory/u],
    [[{ name: '/a' }], /is absolute/u],
    [[{ name: '../a' }], /has a \.\. segment/u],
    [[{ name: 'a\\b' }], /control or formatting character, or a backslash/u],
    [[{ name: 'a' }, { name: 'a', data: utf8('x') }], /duplicate entry "a" differs in data/u],
    [[{ name: 'a' }, { name: 'a/b' }], /"a\/b" is inside "a", which is not a directory/u],
  ]
  for (const [entries, message] of refused) {
    it(`refuses ${JSON.stringify(entries).slice(0, 60)}`, async () => {
      await assert.rejects(zip(entries), message)
    })
  }
  it('refuses a method it does not have, and non-iterable entries', async () => {
    await assert.rejects(zip([], { method: 'bzip2' }), /method "bzip2" is not deflate or store/u)
    await assert.rejects(zip(null), TypeError)
  })
  it('throws ArchiveError without an offset', async () => {
    await assert.rejects(zip([{}]), (error) => error instanceof ArchiveError && error.offset === undefined)
  })
  it('stops short of the entry count a reader takes as zip64, and reads back the most it writes', async () => {
    const named = function* named(count) {
      for (let i = 0; i < count; i++) yield { name: `f${i}` }
    }
    await assert.rejects(zip(named(0xffff)), /more than 65534 entries would need zip64/u)
    assert.equal((await unzip(await zip(named(0xfffe)))).length, 0xfffe)
  })
})
