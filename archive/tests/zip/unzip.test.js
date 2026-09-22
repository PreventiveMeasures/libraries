import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError, unzip, zip } from '../../zip.js'
import { concat } from '../../src/bytes.js'
import { deflate, record } from '../../src/zip/format.js'
import { crc32 } from '@exodus/bytes/crc.js'
import { RECORDINGS, bytesOf } from './fixtures/info-zip.js'
import { entriesOf, readable, utf8 } from '../helpers.js'

// unzip() reads every recording back as the entries it was made from, and
// refuses everything malformed, inconsistent or unsafe with a message that
// says why. Archives for the latter are built here piece by piece.

const T = 1577836800
const DOS = { time: 0, date: ((2020 - 1980) << 9) | (1 << 5) | 1 } // 2020-01-01 00:00:00
const UNIX = 3 << 8

// One entry's local record and central record, with every field a test can
// bend. `over` holds field overrides for either side.
function entry(name, data, over = {}) {
  const rawName = over.rawName ?? utf8(name)
  const body = over.body ?? data
  const crc = over.crc ?? crc32(data)
  const flags = over.flags ?? 0
  const method = over.method ?? 0
  const extra = over.extra ?? new Uint8Array(0)
  const local = concat([record([
    [4, 0x04034b50], [2, 10], [2, over.localFlags ?? flags], [2, over.localMethod ?? method], [2, over.localTime ?? over.time ?? DOS.time], [2, over.date ?? DOS.date],
    [4, over.localCrc ?? crc], [4, over.localCsize ?? body.length], [4, over.localUsize ?? data.length], [2, rawName.length], [2, extra.length],
  ]), over.localName ?? rawName, extra, body, over.descriptor ?? new Uint8Array(0)])
  const central = (offset) => concat([record([
    [4, 0x02014b50], [2, over.madeBy ?? UNIX | 20], [2, 10], [2, flags], [2, method], [2, over.time ?? DOS.time], [2, over.date ?? DOS.date],
    [4, crc], [4, over.csize ?? body.length], [4, over.usize ?? data.length], [2, rawName.length], [2, (over.centralExtra ?? extra).length], [2, 0],
    [2, over.disk ?? 0], [2, 0], [4, over.attributes ?? 0o100644 * 0x10000], [4, over.offset ?? offset],
  ]), rawName, over.centralExtra ?? extra])
  return { local, central }
}

// An archive from entries, laid out tightly unless `gap` bytes are put
// before the central directory or `before` bytes before the end record;
// `end` overrides end-record fields.
function archive(entries, { gap = new Uint8Array(0), before = new Uint8Array(0), end = {} } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    locals.push(e.local)
    centrals.push(e.central(offset))
    offset += e.local.length
  }
  const directory = concat(centrals)
  const start = offset + gap.length
  const comment = end.comment ?? new Uint8Array(0)
  return concat([...locals, gap, directory, before, record([
    [4, 0x06054b50], [2, end.disk ?? 0], [2, end.disk ?? 0], [2, end.count ?? entries.length], [2, end.total ?? entries.length],
    [4, end.size ?? directory.length], [4, end.start ?? start], [2, end.commentLength ?? comment.length],
  ]), comment])
}

// The stamp is a signed 32-bit time; a negative one is written as its unsigned bits.
const ut = (mtime) => record([[2, 0x5455], [2, 5], [1, 1], [4, mtime >>> 0]])

describe('unzip reads every recording back', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, async () => {
      assert.deepEqual(readable(await unzip(bytesOf(recording))), recording.entries)
      const again = await unzip(await zip(entriesOf(recording)))
      assert.deepEqual(readable(again), recording.entries)
    })
  }
})

describe('what it reads', () => {
  it('an empty archive', async () => {
    assert.deepEqual(await unzip(archive([])), [])
  })
  it('a comment on the end record', async () => {
    assert.equal((await unzip(archive([entry('a', utf8('x'))], { end: { comment: utf8('hi') } }))).length, 1)
  })
  it('a deflated entry, with a data descriptor with or without its signature', async () => {
    const data = new Uint8Array(3000).fill(0x62)
    const body = await deflate(data)
    const descriptor = (signed) => concat([signed ? record([[4, 0x08074b50]]) : new Uint8Array(0), record([[4, crc32(data)], [4, body.length], [4, data.length]])])
    for (const signed of [true, false]) {
      const [e] = await unzip(archive([entry('a', data, { body, method: 8, flags: 8, localCrc: 0, localCsize: 0, localUsize: 0, descriptor: descriptor(signed) })]))
      assert.equal(e.data.length, 3000)
    }
  })
  it('a directory deflated to nothing, as Java writes one', async () => {
    const body = await deflate(new Uint8Array(0))
    const [d] = await unzip(archive([entry('d/', new Uint8Array(0), { body, method: 8, attributes: 0o40755 * 0x10000 + 0x10 })]))
    assert.deepEqual([d.name, d.type, d.mode], ['d', 'directory', 0o755])
  })
  it('an mtime from the extended timestamp over DOS time, and DOS time as UTC without one', async () => {
    assert.equal((await unzip(archive([entry('a', utf8('x'), { extra: ut(T + 1) })])))[0].mtime, T + 1)
    assert.equal((await unzip(archive([entry('a', utf8('x'))])))[0].mtime, T)
    assert.equal((await unzip(archive([entry('a', utf8('x'), { extra: ut(-1) })])))[0].mtime, -1)
  })
  it('a symlink by its Unix mode, with its target as its data', async () => {
    const [l] = await unzip(archive([entry('l', utf8('a/b'), { attributes: 0o120777 * 0x10000 })]))
    assert.deepEqual([l.type, l.linkname, l.data.length], ['symlink', 'a/b', 0])
  })
  it('default modes from a maker that is not Unix, or that recorded none', async () => {
    const [f, d] = await unzip(archive([entry('a', utf8('x'), { madeBy: 20, attributes: 0x20 }), entry('d/', new Uint8Array(0), { madeBy: 20, attributes: 0x10 })]))
    assert.deepEqual([f.mode, d.mode], [0o644, 0o755])
    assert.equal((await unzip(archive([entry('a', utf8('x'), { attributes: 0 })])))[0].mode, 0o644)
  })
  it('names cleaned, and a name again as the same entry', async () => {
    const entries = await unzip(archive([entry('./d/f', utf8('x')), entry('d/./f', utf8('x'))]))
    assert.deepEqual(entries.map((e) => e.name), ['d/f', 'd/f'])
  })
  it('stored data as a view over the archive', async () => {
    const bytes = archive([entry('a', utf8('x'))])
    assert.equal((await unzip(bytes))[0].data.buffer, bytes.buffer)
  })
})

describe('what it refuses', () => {
  const x = () => entry('a', utf8('x'))
  const refused = [
    ['not bytes', () => 'zip', /the archive is not a Uint8Array/u],
    ['too little for an end record', () => new Uint8Array(21), /no end of central directory record/u],
    ['an archive cut short', () => archive([x()]).subarray(0, -1), /no end of central directory record/u],
    ['bytes after the end record', () => concat([archive([x()]), utf8('junk')]), /no end of central directory record/u],
    ['a comment length that lies', () => archive([x()], { end: { commentLength: 3 } }), /no end of central directory record/u],
    ['a second disk', () => archive([x()], { end: { disk: 1 } }), /the archive spans several disks/u],
    ['an entry on another disk', () => archive([entry('a', utf8('x'), { disk: 1 })]), /the archive spans several disks/u],
    ['a count that disagrees with the total', () => archive([x()], { end: { total: 2 } }), /the archive spans several disks/u],
    ['a central directory of the wrong size', () => archive([x()], { end: { size: 10 } }), /the central directory does not end at the end record/u],
    ['a central directory that starts elsewhere', () => archive([x()], { end: { start: 0 } }), /the central directory does not end at the end record/u],
    ['more entries counted than present', () => archive([x()], { end: { count: 2, total: 2 } }), /no central directory entry where one is counted at byte 79/u],
    ['fewer entries counted than present', () => archive([x(), entry('b', utf8('y'))], { end: { count: 1, total: 1, size: 47 + 2 } }), /the central directory does not end at the end record/u],
    ['a zip64 end record locator', () => archive([x()], { before: record([[4, 0x07064b50], [4, 0], [4, 0], [4, 0], [4, 1]]) }), /zip64 is not supported/u],
    ['a zip64 count', () => archive([x()], { end: { count: 0xffff, total: 0xffff } }), /zip64 is not supported/u],
    ['a zip64 size in an entry', () => archive([entry('a', utf8('x'), { usize: 0xffffffff })]), /zip64 is not supported/u],
    ['a zip64 extra field', () => archive([entry('a', utf8('x'), { extra: record([[2, 1], [2, 0]]) })]), /zip64 is not supported/u],
    ['an encrypted entry', () => archive([entry('a', utf8('x'), { flags: 1 })]), /an entry is encrypted/u],
    ['a local header with other flags', () => archive([entry('a', utf8('x'), { localFlags: 1 })]), /the local header has different flags at byte 0/u],
    ['a local header with a descriptor bit the central directory lacks', () => archive([entry('a', utf8('x'), { localFlags: 8, localCrc: 0, localCsize: 0, localUsize: 0, descriptor: record([[4, crc32(utf8('x'))], [4, 1], [4, 1]]) })]), /the local header has different flags/u],
    ['a local header with another time', () => archive([entry('a', utf8('x'), { localTime: 1 })]), /the local header has a different time/u],
    ['a compression method it does not have', () => archive([entry('a', utf8('x'), { method: 12, localMethod: 12 })]), /compression method 12 is not stored or deflate/u],
    ['a local header naming another entry', () => archive([entry('a', utf8('x'), { localName: utf8('b') })]), /the local header names a different entry/u],
    ['a local header with another method', () => archive([entry('a', utf8('x'), { localMethod: 8 })]), /the local header has a different compression method/u],
    ['a local header with another size', () => archive([entry('a', utf8('x'), { localUsize: 2 })]), /the local header disagrees with the central directory/u],
    ['a local header with another CRC', () => archive([entry('a', utf8('x'), { localCrc: 1 })]), /the local header disagrees with the central directory/u],
    ['a data descriptor that disagrees', () => archive([entry('a', utf8('x'), { flags: 8, descriptor: record([[4, 1], [4, 1], [4, 1]]) })]), /the data descriptor disagrees with the central directory/u],
    ['a stored entry with two sizes', () => archive([entry('a', utf8('xy'), { body: utf8('x'), localCsize: 1, csize: 1 })]), /a stored entry has two sizes/u],
    ['data that does not match its CRC', () => archive([entry('a', utf8('x'), { crc: 1, localCrc: 1 })]), /the data does not match its CRC-32/u],
    ['a directory with data', () => archive([entry('d/', utf8('x'), { attributes: 0o40755 * 0x10000 })]), /directory "d\/" has data/u],
    ['a directory by its mode but not its name', () => archive([entry('d', new Uint8Array(0), { attributes: 0o40755 * 0x10000 })]), /"d" is a directory by its mode but not by its name/u],
    ['a directory by its name but not its mode', () => archive([entry('d/', new Uint8Array(0), { attributes: 0o100644 * 0x10000 })]), /"d\/" is a directory by its name but not by its mode/u],
    ['a directory by its attributes but not its name', () => archive([entry('d', new Uint8Array(0), { attributes: 0x10 })]), /"d" is a directory by its attributes but not by its name/u],
    ['a mode it does not read', () => archive([entry('c', new Uint8Array(0), { attributes: 0o20644 * 0x10000 })]), /the mode of "c" \(20644\) is not one this package reads/u],
    ['a symlink pointing out', () => archive([entry('l', utf8('../x'), { attributes: 0o120777 * 0x10000 })]), /symlink "l" points outside the archive/u],
    ['a symlink target that is not UTF-8', () => archive([entry('l', Uint8Array.from([0xff]), { attributes: 0o120777 * 0x10000 })]), /symlink target is not valid UTF-8/u],
    ['a name that is not UTF-8', () => archive([entry('x', utf8('x'), { rawName: Uint8Array.from([0xff]) })]), /entry name is not valid UTF-8/u],
    ['an absolute name', () => archive([entry('/a', utf8('x'))]), /entry name "\/a" is absolute/u],
    ['a name on a Windows drive', () => archive([entry('C:/a', utf8('x'))]), /entry name "C:\/a" starts with a drive letter/u],
    ['a symlink to a Windows drive', () => archive([entry('l', utf8('C:/x'), { attributes: 0o120777 * 0x10000 })]), /symlink target of "l" "C:\/x" starts with a drive letter/u],
    ['a name that climbs out', () => archive([entry('../a', utf8('x'))]), /has a \.\. segment/u],
    ['a name with a backslash', () => archive([entry('a\\b', utf8('x'))]), /control character or a backslash/u],
    ['a name twice as a different entry', () => archive([x(), entry('a', utf8('y'))]), /duplicate entry "a" differs in data/u],
    ['an entry inside a file', () => archive([x(), entry('a/b', utf8('y'))]), /"a\/b" is inside "a", which is not a directory/u],
    ['an invalid DOS time', () => archive([entry('a', utf8('x'), { date: (40 << 9) | (13 << 5) | 1 })]), /an entry has an invalid DOS time/u],
    ['an extra field past its room', () => archive([entry('a', utf8('x'), { extra: record([[2, 0x5455], [2, 9], [1, 1]]) })]), /an extra field runs past its room/u],
  ]
  for (const [what, bytes, message] of refused) {
    it(`refuses ${what}`, async () => {
      await assert.rejects(unzip(bytes()), message)
    })
  }
  it('refuses bytes that belong to no entry, and entries that overlap', async () => {
    await assert.rejects(unzip(archive([x()], { gap: new Uint8Array(1) })), /bytes belong to no entry at byte 32/u)
    await assert.rejects(unzip(archive([entry('a', utf8('x'), { offset: 1 })])), /bytes belong to no entry at byte 0/u)
    await assert.rejects(unzip(archive([x(), entry('b', utf8('y'), { offset: 0 })])), /two entries overlap at byte 32/u)
    await assert.rejects(unzip(archive([x()]).with(0, 0)), /no local header where the central directory points at byte 0/u)
  })
  it('refuses deflated data that does not inflate, or inflates to another size', async () => {
    const data = new Uint8Array(3000).fill(0x62)
    const body = await deflate(data)
    await assert.rejects(unzip(archive([entry('a', data, { body: body.map((b) => b ^ 0xff), method: 8 })])), /an entry does not inflate/u)
    await assert.rejects(unzip(archive([entry('a', data, { body, method: 8, usize: 2999, localUsize: 2999 })])), /an entry inflates to more than its declared size/u)
    await assert.rejects(unzip(archive([entry('a', data, { body, method: 8, usize: 3001, localUsize: 3001 })])), /an entry inflates to less than its declared size/u)
  })
  it('throws ArchiveError with the offset', async () => {
    // The offset of the second entry's central record: two local entries
    // of 32 bytes, then the first central record of 47.
    await assert.rejects(unzip(archive([x(), entry('a', utf8('y'))])), (error) => error instanceof ArchiveError && error.offset === 111)
  })
})
