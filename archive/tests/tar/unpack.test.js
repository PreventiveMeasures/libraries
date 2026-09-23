import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError, pack, unpack } from '../../tar.js'
import { EMPTY, concat } from '../../src/bytes.js'
import { BLOCK, encodeHeader } from '../../src/tar/header.js'
import { encodePax } from '../../src/tar/pax.js'
import { RECORDINGS, bytesOf } from './fixtures/gnu-tar.js'
import { assertBytes, entriesOf, readable, utf8 } from '../helpers.js'

// unpack() reads every recording back as the entries it was made from,
// pack() then writes it again byte for byte, and everything malformed,
// inconsistent or unsafe is refused with a message that says why.

const ZERO = new Uint8Array(BLOCK)
const latin1 = (text) => Uint8Array.from(text, (c) => c.codePointAt(0))

const fields = (over) => ({
  gnu: false, name: utf8('a'), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
  typeflag: 0x30, mode: 0o644, uid: 0, gid: 0, size: 0, mtime: 0, devmajor: null, devminor: null, ...over,
})
const header = (over) => encodeHeader(fields(over))

const padded = (bytes) => {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK)
  out.set(bytes)
  return out
}

// An archive from its blocks, ended the way tar ends one.
const archive = (...parts) => concat([...parts, ZERO, ZERO])

// A pax header and its records, ahead of the header they describe.
const pax = (records, over = {}, typeflag = 0x78) => {
  const body = records instanceof Uint8Array ? records : encodePax(records)
  return [header({ typeflag, size: body.length }), padded(body), header(over)]
}

// A header edited after the fact, with its checksum made good again.
function sealed(block, edit) {
  const out = block.slice()
  edit(out)
  out.fill(0x20, 148, 156)
  const sum = out.reduce((a, b) => a + b, 0)
  out.set(utf8(sum.toString(8).padStart(6, '0')), 148)
  out[154] = 0
  return out
}

describe('unpack reads every recording back', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, () => {
      const bytes = bytesOf(recording)
      assert.deepEqual(readable(unpack(bytes)), recording.entries)
      assertBytes(pack(unpack(bytes), { format: recording.format, blocking: recording.blocking }), bytes, 'the bytes written again')
    })
  }
})

describe('what it refuses', () => {
  const refused = [
    ['nothing at all', () => new Uint8Array(0), /the archive is empty/u],
    ['a chunk that is not bytes', () => 'tar', /a chunk is not a Uint8Array/u],
    ['a block that is not a header', () => new Uint8Array(1024).fill(1), /the checksum field is not an octal number at byte 0/u],
    ['a header whose checksum is off', () => archive(broken(header())), /header checksum does not match at byte 0/u],
    ['a v7 header, whose magic is blank', () => archive(sealed(header(), (b) => b.fill(0, 257, 265))), /not in the ustar, pax or gnu format at byte 0/u],
    ['an archive cut inside its data', () => pack([{ name: 'a', data: utf8('hello') }]).subarray(0, 515), /the archive is truncated at byte 512/u],
    ['an archive with no end marker', () => pack([{ name: 'a', data: utf8('hello') }]).subarray(0, 1024), /the archive has no end marker at byte 1024/u],
    ['an archive ending in one zero block', () => pack([{ name: 'a' }]).subarray(0, 1024), /the archive ends with a lone zero block at byte 1024/u],
    ['nothing but one zero block', () => ZERO, /ends with a lone zero block/u],
    ['a zero block between two headers', () => archive(header(), ZERO, header({ name: utf8('b') })), /a lone zero block where a header should be at byte 1024/u],
    ['anything after the end marker', () => concat([pack([{ name: 'a' }], { blocking: 1 }), utf8('junk')]), /data after the end of the archive at byte 1536/u],
    ['a type it does not model', () => archive(header({ typeflag: 0x53 })), /entry type "S" is not one this package reads at byte 0/u],
    ['a volume label', () => archive(header({ typeflag: 0x56 })), /entry type "V" is not one/u],
    ['a directory with a size', () => archive(header({ typeflag: 0x35, name: utf8('d/'), size: 5 }), padded(utf8('hello'))), /a directory entry has a size at byte 0/u],
    ['a hard link with a size', () => archive(header(), header({ typeflag: 0x31, name: utf8('h'), linkname: utf8('a'), size: 1 }), ZERO), /a link entry has a size/u],
    ['a symlink without a target', () => archive(header({ typeflag: 0x32, name: utf8('l') })), /symlink target of "l" is empty at byte 0/u],
    ['a file with a link target', () => archive(header({ linkname: utf8('x') })), /a file entry has a link target/u],
    ['padding that is not zero', () => sealedData(), /the padding after an entry is not zero at byte 0/u],
    ['a pax header with nothing after it', () => archive(...pax([['path', 'x']]).slice(0, 2)), /an extended header is not followed by an entry at byte 1024/u],
    ['two pax headers ahead of one entry', () => archive(...pax([['uid', '1']]).slice(0, 2), ...pax([['gid', '1']])), /two pax headers ahead of one entry at byte 1024/u],
    ['a long name and a pax path for one entry', () => archive(header({ gnu: true, typeflag: 0x4c, name: utf8('././@LongLink'), size: 2 }), padded(utf8('b\0')), ...pax([['path', 'c']])), /both a long name header and a pax path name one entry/u],
    ['a pax header too large to be one', () => archive(header({ typeflag: 0x78, size: 1 << 21 })), /a pax header of 2097152 bytes is longer than any tar writes/u],
    ['a pax record without its length', () => archive(...pax(utf8('path=x\n'))), /a pax record does not begin with its length at byte 0/u],
    ['a pax record with a leading zero', () => archive(...pax(utf8('07 a=1\n'))), /does not begin with its length/u],
    ['a pax record longer than its bytes', () => archive(...pax(utf8('99 path=a\n'))), /a pax record is not as long as it says/u],
    ['a pax record not ending in a newline', () => archive(...pax(utf8('8 a=1\n9 b=2\n'))), /is not as long as it says/u],
    ['a pax record without =', () => archive(...pax(utf8('9 pathxa\n'))), /a pax record has no keyword=value/u],
    ['a pax record without a keyword', () => archive(...pax(utf8('7 =abc\n'))), /pax keyword "" is malformed/u],
    ['a pax keyword with a space in it', () => archive(...pax(utf8('8 a b=1\n'))), /pax keyword "a b" is malformed/u],
    ['a pax keyword twice', () => archive(...pax(utf8('6 a=1\n6 a=2\n'))), /pax keyword a repeats/u],
    ['a pax value that is not UTF-8', () => archive(...pax(Uint8Array.from([0x36, 0x20, 0x61, 0x3d, 0xff, 0x0a]))), /a pax record is not valid UTF-8/u],
    ['a sparse file', () => archive(...pax([['GNU.sparse.size', '10']])), /sparse entries are not supported/u],
    // libarchive reads these as a sparse file too: star's real size makes
    // three stored bytes a hundred-byte file, Solaris' map lays out holes.
    ['a real size from star', () => archive(...pax([['SCHILY.realsize', '100']], { size: 3 }), padded(utf8('abc'))), /sparse entries are not supported at byte 1024/u],
    ['a map of holes from Solaris', () => archive(...pax([['SUN.holesdata', ' 0 3']], { size: 3 }), padded(utf8('abc'))), /sparse entries are not supported at byte 1024/u],
    ['a global header with a real size from star', () => archive(...pax([['SCHILY.realsize', '100']], {}, 0x67)), /sparse entries are not supported at byte 0/u],
    // libarchive reads the old GNU sparse fields under the gnu magic whatever
    // the type, and follows isextended into the blocks after the header.
    ['an old GNU sparse map on a plain file', () => archive(sealed(header({ gnu: true }), (b) => b.set(latin1('00000000000'), 386))), /header carries an old GNU sparse map or real size at byte 0/u],
    ['an old GNU isextended flag on a plain file', () => archive(sealed(header({ gnu: true }), (b) => (b[482] = 1))), /header carries an old GNU sparse map or real size/u],
    ['an old GNU real size on a plain file', () => archive(sealed(header({ gnu: true }), (b) => b.set(latin1('00000000144'), 483))), /header carries an old GNU sparse map or real size/u],
    ['a pax size that is not a number', () => archive(...pax([['size', '1x']])), /pax size="1x" is not a whole number this package can hold/u],
    ['a pax size below zero', () => archive(...pax([['size', '-1']])), /pax size="-1" is not a whole number/u],
    ['a pax uid too large to hold', () => archive(...pax([['uid', '99999999999999999999']])), /pax uid="99999999999999999999" is not a whole number this package can hold/u],
    ['a pax mtime that is not a time', () => archive(...pax([['mtime', 'abc']])), /pax mtime="abc" is not a time/u],
    ['a pax path that climbs out', () => archive(...pax([['path', '../x']])), /has a \.\. segment at byte 1024/u],
    ['an absolute name', () => archive(header({ name: utf8('/x') })), /entry name "\/x" is absolute at byte 0/u],
    ['a name on a Windows drive', () => archive(header({ name: utf8('C:x') })), /entry name "C:x" starts with a drive letter at byte 0/u],
    ['a name on a Windows drive behind a dot segment', () => archive(header({ name: utf8('./C:x') })), /entry name "\.\/C:x" starts with a drive letter at byte 0/u],
    ['a name with a backslash', () => archive(header({ name: utf8('a\\b') })), /control or formatting character, or a backslash/u],
    ['a name that is not UTF-8', () => archive(header({ name: Uint8Array.from([0xff, 0x61]) })), /entry name is not valid UTF-8 at byte 0/u],
    ['a name twice as a different entry', () => archive(header(), header({ mtime: 1 })), /duplicate entry "a" differs in mtime at byte 512/u],
    ['a name twice with different data', () => archive(header({ size: 1 }), padded(utf8('x')), header({ size: 1 }), padded(utf8('y'))), /duplicate entry "a" differs in data at byte 1024/u],
    ['a name twice as a file and a directory', () => archive(header(), header({ typeflag: 0x35, name: utf8('a/') })), /duplicate entry "a" differs in type/u],
    ['a symlink pointing out of the archive', () => archive(header({ typeflag: 0x32, name: utf8('l'), linkname: utf8('../x') })), /symlink "l" points outside the archive/u],
    ['a hard link to nothing', () => archive(header({ typeflag: 0x31, name: utf8('h'), linkname: utf8('a') })), /hard link "h" targets "a", which is not an earlier non-directory entry/u],
    ['an entry through a symlink', () => archive(header({ typeflag: 0x32, name: utf8('l'), linkname: utf8('x') }), header({ name: utf8('l/a') })), /"l\/a" is inside "l", which is not a directory at byte 512/u],
    ['a directory that ends in two slashes', () => archive(header({ typeflag: 0x35, name: utf8('d//') })), /has an empty segment/u],
    ['a symlink whose name ends in a slash', () => archive(header({ typeflag: 0x32, name: utf8('l/'), linkname: utf8('a') })), /"l\/" ends in a slash but is not a directory/u],
    ['a file whose name ends in a slash', () => archive(header({ name: utf8('d/') })), /"d\/" ends in a slash but is not a directory at byte 0/u],
    ['a file named as the archive root', () => archive(header({ name: utf8('.') })), /names the archive root but is not a directory/u],
    ['a directory with an empty segment', () => archive(header({ typeflag: 0x35, name: utf8('a//b/') })), /has an empty segment/u],
    ['a name twice once . segments are dropped, as a different entry', () => archive(header(), header({ name: utf8('./a'), mode: 0o600 })), /duplicate entry "a" differs in mode at byte 512/u],
    ['a size below zero in base 256', () => archive(header({ gnu: true, size: -1 })), /the size field is negative at byte 0/u],
    ['a uid below zero in base 256', () => archive(header({ gnu: true, uid: -1 })), /the uid field is negative at byte 0/u],
    ['an owner name with a control character', () => archive(...pax([['uname', 'a\nb']])), /uname "a\\nb" holds a control or formatting character at byte 1024/u],
    ['an owner name field with a control character', () => archive(header({ gname: utf8('a\tb') })), /gname "a\\tb" holds a control or formatting character/u],
    ['a global header that sets a size', () => archive(...pax([['size', '1']], {}, 0x67)), /a global header sets size at byte 0/u],
    ['a global header that sets a path', () => archive(...pax([['path', 'x']], {}, 0x67)), /a global header sets path/u],
    ['a global header that makes every entry sparse', () => archive(...pax([['GNU.sparse.size', '10']], {}, 0x67)), /sparse entries are not supported at byte 0/u],
    ['a hard link to a symlink that points out from the link', () => archive(header({ typeflag: 0x32, name: utf8('a/b/s'), linkname: utf8('../x') }), header({ typeflag: 0x31, name: utf8('h'), linkname: utf8('a/b/s') })), /symlink "h" points outside the archive/u],
    ['a hard link to a hard link to such a symlink', () => archive(header({ typeflag: 0x32, name: utf8('a/b/s'), linkname: utf8('../x') }), header({ typeflag: 0x31, name: utf8('a/b/h'), linkname: utf8('a/b/s') }), header({ typeflag: 0x31, name: utf8('h2'), linkname: utf8('a/b/h') })), /symlink "h2" points outside the archive, to "\.\.\/x" at byte 1024/u],
  ]
  for (const [what, bytes, message] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => unpack(bytes()), message))
  }
  it('throws ArchiveError with the offset', () => {
    assert.throws(() => unpack(archive(header(), header({ mtime: 1 }))), (error) => error instanceof ArchiveError && error.offset === 512)
  })
})

// A header with one byte changed and its checksum left as it was.
function broken(block) {
  const out = block.slice()
  out[100] = 0x31
  return out
}

function sealedData() {
  const bytes = pack([{ name: 'a', data: utf8('hello') }], { blocking: 1 })
  bytes[512 + 5] = 1
  return bytes
}

describe('what it reads that GNU tar reads', () => {
  it('blank numeric fields as 0, which npm wrote for uid and gid', () => {
    const block = header({ uid: 7, gid: 7 })
    block.fill(0, 108, 124)
    const resealed = sealed(block, () => {})
    assert.deepEqual([unpack(archive(resealed))[0].uid, unpack(archive(resealed))[0].gid], [0, 0])
  })
  it('a name again as the same entry, as some packagers write d/f and d/./f', () => {
    const entries = unpack(archive(header({ name: utf8('d/f'), size: 1 }), padded(utf8('x')), header({ name: utf8('d/./f'), size: 1 }), padded(utf8('x'))))
    assert.deepEqual(entries.map((e) => [e.name, new TextDecoder().decode(e.data)]), [['d/f', 'x'], ['d/f', 'x']])
  })
  it('a size field that opens with a NUL as 0, so the block after it is the next header', () => {
    // GNU ends the number at the NUL and reads b; taking the digits past it
    // as 512 would swallow b's header as a's data, and b with it.
    const block = sealed(header(), (b) => b.set(Uint8Array.from([0, 0, ...utf8('0000001000')]), 124))
    const entries = unpack(archive(block, header({ name: utf8('b'), size: 1 }), padded(utf8('x'))))
    assert.deepEqual(entries.map((e) => [e.name, e.data.length]), [['a', 0], ['b', 1]])
  })
  it('a NUL typeflag as a file', () => {
    assert.equal(unpack(archive(header({ typeflag: 0 })))[0].type, 'file')
  })
  it('names with . segments and a directory slash, cleaned, and the root as .', () => {
    const entries = unpack(archive(
      header({ typeflag: 0x35, name: utf8('./') }),
      header({ name: utf8('./a') }),
      header({ typeflag: 0x35, name: utf8('./d/./') }),
      header({ typeflag: 0x31, name: utf8('./h'), linkname: utf8('./a') }),
    ))
    assert.deepEqual(entries.map((e) => [e.type, e.name, e.linkname]), [['directory', '.', ''], ['file', 'a', ''], ['directory', 'd', ''], ['link', 'h', 'a']])
  })
  it('a time below zero in base 256', () => {
    assert.equal(unpack(archive(header({ gnu: true, mtime: -1 })))[0].mtime, -1)
  })
  it('a mode with the file type bits still in it, as the permission bits', () => {
    assert.equal(unpack(archive(header({ mode: 0o100644 })))[0].mode, 0o644)
  })
  it('numbers written the way older tars wrote them', () => {
    const block = sealed(header(), (b) => b.set(latin1('   644  '), 100))
    assert.equal(unpack(archive(block))[0].mode, 0o644)
  })
  it('a pax record over the field it stands in for', () => {
    const [entry] = unpack(archive(...pax([['path', 'b'], ['size', '5'], ['uid', '7'], ['gid', '8'], ['uname', 'me'], ['gname', 'us']], { size: 0 }), padded(utf8('hello'))))
    assert.deepEqual(readable([entry]), [{ name: 'b', type: 'file', mode: 0o644, uid: 7, gid: 8, mtime: 0, uname: 'me', gname: 'us', linkname: '', devmajor: 0, devminor: 0, data: 'hello' }])
  })
  it('a pax mtime with a fraction, as whole seconds toward minus infinity', () => {
    assert.equal(unpack(archive(...pax([['mtime', '1577836800.5']])))[0].mtime, 1577836800)
    assert.equal(unpack(archive(...pax([['mtime', '-1.5']])))[0].mtime, -2)
    // GNU writes nanoseconds; so close to the next second, a double rounds
    // up to it, and the floor has to come from the digits.
    assert.equal(unpack(archive(...pax([['mtime', '1577836800.999999999']])))[0].mtime, 1577836800)
    assert.equal(unpack(archive(...pax([['mtime', '-1577836800.000000001']])))[0].mtime, -1577836801)
    assert.equal(unpack(archive(...pax([['mtime', '-1577836800.000']])))[0].mtime, -1577836800)
  })
  it('device numbers from pax records', () => {
    const [device] = unpack(archive(...pax([['devmajor', '300'], ['devminor', '4']], { typeflag: 0x34, name: utf8('b'), devmajor: 0, devminor: 0 })))
    assert.deepEqual([device.type, device.devmajor, device.devminor], ['block-device', 300, 4])
  })
  it('a global header, for every entry after it until a pax header says otherwise', () => {
    const [first, second, third] = unpack(archive(
      ...pax([['uname', 'alice']], { name: utf8('a') }, 0x67),
      ...pax([['uname', 'bob']], { name: utf8('b') }),
      header({ name: utf8('c') }),
    ))
    assert.deepEqual([first.uname, second.uname, third.uname], ['alice', 'bob', 'alice'])
  })
  it('a pax keyword it does not model, by ignoring it', () => {
    assert.equal(unpack(archive(...pax([['comment', 'hi'], ['atime', '1'], ['SCHILY.xattr.user.x', 'y']])))[0].name, 'a')
  })
  it('zeros after the end marker, however many', () => {
    assert.equal(unpack(concat([pack([{ name: 'a' }], { blocking: 1 }), new Uint8Array(3)])).length, 1)
    assert.equal(unpack(new Uint8Array(10240)).length, 0)
  })
  it('a name that fills its field', () => {
    assert.equal(unpack(archive(header({ name: utf8('n'.repeat(100)) })))[0].name, 'n'.repeat(100))
  })
})

describe('what it hands back', () => {
  it('data that views the archive where it arrived whole', () => {
    const bytes = pack([{ name: 'a', data: utf8('hello') }])
    const [entry] = unpack(bytes)
    assert.equal(entry.data.buffer, bytes.buffer)
    assert.equal(entry.data.byteOffset, 512)
    assert.equal(new TextDecoder().decode(entry.data), 'hello')
  })
  it('entries pack() takes back as they are', () => {
    for (const recording of RECORDINGS) {
      const entries = unpack(bytesOf(recording))
      assert.deepEqual(readable(unpack(pack(entries, { format: recording.format }))), readable(entriesOf(recording)))
    }
  })
})
