import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError, pack, unpack } from '../../tar.js'
import { RECORDINGS, bytesOf } from './fixtures/gnu-tar.js'
import { assertBytes, entriesOf, utf8 } from '../helpers.js'

// pack() is held to GNU tar byte for byte, on every recording, and to
// refusing what an archive could not say truthfully.

describe('pack writes what GNU tar writes', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, () => {
      assertBytes(pack(entriesOf(recording), { format: recording.format, blocking: recording.blocking }), bytesOf(recording))
    })
  }
})

describe('what it refuses about an entry', () => {
  const refused = [
    [null, /an entry is not an object/u],
    ['a', /an entry is not an object/u],
    [{}, /entry name is not a string/u],
    [{ name: 'a', type: 'socket' }, /entry type "socket" is not one this package writes/u],
    [{ name: 'a/' }, /"a\/" ends in a slash but is not a directory/u],
    [{ name: '.' }, /"\." names the archive root but is not a directory/u],
    [{ name: 'a', data: 'text' }, /data of "a" is not a Uint8Array/u],
    [{ name: 'd', type: 'directory', data: utf8('x') }, /a directory cannot carry data \("d"\)/u],
    [{ name: 'a', linkname: 'b' }, /a file cannot have a link target \("a"\)/u],
    [{ name: 'l', type: 'symlink' }, /symlink target of "l" is empty/u],
    [{ name: 'h', type: 'link' }, /hard link target of "h" is empty/u],
    [{ name: 'a', devmajor: 1 }, /a file cannot have device numbers/u],
    [{ name: 'a', mode: 0o100644 }, /mode 100644 has bits beyond the permission bits/u],
    [{ name: 'a', mode: -1 }, /mode -1 is not a non-negative integer/u],
    [{ name: 'a', uid: 1.5 }, /uid 1\.5 is not a non-negative integer/u],
    [{ name: 'a', gid: -1 }, /gid -1 is not a non-negative integer/u],
    [{ name: 'a', mtime: 1.5 }, /mtime 1\.5 is not an integer/u],
    [{ name: 'a', mtime: '0' }, /mtime 0 is not an integer/u],
    [{ name: 'a', uname: 'a\nb' }, /uname "a\\nb" holds a control character/u],
    [{ name: 'a', gname: 7 }, /gname is not a string/u],
    [{ name: 'a\uD800' }, /entry name is not well-formed Unicode/u],
    [{ name: 'l', type: 'symlink', linkname: 'x\uDC00' }, /symlink target of "l" is not well-formed Unicode/u],
    [{ name: 'h\uDBFF' }, /entry name is not well-formed Unicode/u],
  ]
  for (const [entry, message] of refused) {
    it(`refuses ${JSON.stringify(entry)}`, () => assert.throws(() => pack([entry]), message))
  }
  it('throws ArchiveError, with no offset', () => {
    assert.throws(() => pack([{}]), (error) => error instanceof ArchiveError && error.name === 'ArchiveError' && error.offset === undefined)
  })
  it('lets a symlink carry an empty data array, which is what unpack gives back', () => {
    pack([{ name: 'l', type: 'symlink', linkname: 'a', data: new Uint8Array(0) }])
  })
})

describe('what it refuses about names', () => {
  const refused = [
    [[{ name: '/etc/passwd' }], /entry name "\/etc\/passwd" is absolute/u],
    [[{ name: '../x' }], /has a \.\. segment/u],
    [[{ name: 'a' }, { name: './a', mode: 0o600 }], /duplicate entry "a" differs in mode/u],
    [[{ name: 'a//b' }], /has an empty segment/u],
    [[{ name: 'a\\b' }], /control character or a backslash/u],
    [[{ name: 'a' }, { name: 'a', data: utf8('x') }], /duplicate entry "a" differs in data/u],
    [[{ name: 'a', data: utf8('x') }, { name: 'a', data: utf8('y') }], /duplicate entry "a" differs in data/u],
    [[{ name: 'a' }, { name: 'a', mtime: 1 }], /duplicate entry "a" differs in mtime/u],
    [[{ name: 'd', type: 'directory' }, { name: 'd' }], /duplicate entry "d" differs in type/u],
    [[{ name: 'a' }, { name: 'a/b' }], /"a\/b" is inside "a", which is not a directory/u],
    [[{ name: 'a/b' }, { name: 'a' }], /"a" holds an earlier entry, so it cannot be a file/u],
    [[{ name: 'l', type: 'symlink', linkname: 'elsewhere' }, { name: 'l/x' }], /is inside "l", which is not a directory/u],
    [[{ name: 'l', type: 'symlink', linkname: '../x' }], /points outside the archive/u],
    [[{ name: 'l', type: 'symlink', linkname: '/x' }], /symlink target of "l" "\/x" is absolute/u],
    [[{ name: 'h', type: 'link', linkname: 'a' }], /hard link "h" targets "a", which is not an earlier non-directory entry/u],
    [[{ name: 'h', type: 'link', linkname: 'a' }, { name: 'a' }], /not an earlier non-directory entry/u],
    [[{ name: 'd', type: 'directory' }, { name: 'h', type: 'link', linkname: 'd' }], /not an earlier non-directory entry/u],
    [[{ name: 'a' }, { name: 'h', type: 'link', linkname: '../a' }], /hard link target of "h" "\.\.\/a" has a \.\. segment/u],
  ]
  for (const [entries, message] of refused) {
    it(`refuses ${entries.map((e) => e.name).join(', ')}`, () => assert.throws(() => pack(entries), message))
  }
  it('lets a directory come after what it holds', () => {
    pack([{ name: 'a/b' }, { name: 'a', type: 'directory' }])
  })
  it('takes a name again as the same entry, and writes it again', () => {
    const twice = unpack(pack([{ name: 'd/f', data: utf8('x') }, { name: 'd/./f', data: utf8('x') }, { name: 'd/', type: 'directory' }, { name: 'd', type: 'directory' }]))
    assert.deepEqual(twice.map((e) => e.name), ['d/f', 'd/f', 'd', 'd'])
  })
  it('drops . segments and a directory slash, and names the root .', () => {
    const entries = unpack(pack([{ name: './', type: 'directory' }, { name: './x' }, { name: 'a/./b' }, { name: 'd/', type: 'directory' }, { name: 'h', type: 'link', linkname: './x' }]))
    assert.deepEqual(entries.map((e) => e.name), ['.', 'x', 'a/b', 'd', 'h'])
    assert.equal(entries[4].linkname, 'x')
  })
})

describe('what each format cannot hold', () => {
  const ustar = (entries) => pack(entries, { format: 'ustar' })
  it('ustar refuses a name it cannot split, and one too long to hold', () => {
    assert.throws(() => ustar([{ name: 'x'.repeat(101) }]), /name "x{101}" cannot be split into ustar's prefix and name fields/u)
    assert.throws(() => ustar([{ name: `${'d'.repeat(160)}/f` }]), /cannot be split/u)
    assert.throws(() => ustar([{ name: `${'d'.repeat(150)}/${'f'.repeat(101)}` }]), /cannot be split/u)
    assert.throws(() => ustar([{ name: `${'d'.repeat(200)}/${'f'.repeat(60)}` }]), /is longer than 256 bytes, which ustar cannot hold/u)
    ustar([{ name: `${'d'.repeat(155)}/${'f'.repeat(100)}` }])
  })
  it('ustar refuses a long link target, a big number and a long owner name', () => {
    assert.throws(() => ustar([{ name: 'l', type: 'symlink', linkname: 'x'.repeat(101) }]), /link target of "l" is longer than 100 bytes, which ustar cannot hold/u)
    assert.throws(() => ustar([{ name: 'a', uid: 2097152 }]), /uid 2097152 of "a" does not fit the ustar format/u)
    assert.throws(() => ustar([{ name: 'a', mtime: -1 }]), /mtime -1 of "a" does not fit the ustar format/u)
    assert.throws(() => ustar([{ name: 'a', mtime: 8589934592 }]), /mtime 8589934592 of "a" does not fit/u)
    assert.throws(() => ustar([{ name: 'a', uname: 'x'.repeat(32) }]), /uname of "a" is longer than 31 bytes, which the ustar format cannot hold/u)
    ustar([{ name: 'a', uname: 'x'.repeat(31), mtime: 8589934591, uid: 2097151 }])
  })
  it('gnu holds any number but still only 31 bytes of an owner name', () => {
    pack([{ name: 'a', uid: 2097152, mtime: -1 }])
    assert.throws(() => pack([{ name: 'a', gname: 'x'.repeat(32) }]), /gname of "a" is longer than 31 bytes, which the gnu format cannot hold/u)
  })
  it('pax holds everything, in a record only when the field cannot', () => {
    const one = (entry) => pack([entry], { format: 'pax', blocking: 1 })
    assert.equal(one({ name: 'a', uname: 'x'.repeat(31) }).length, 512 + 1024)
    assert.equal(one({ name: 'a', uname: 'x'.repeat(32) }).length, 1024 + 512 + 1024)
    assert.equal(unpack(one({ name: 'a', uname: 'x'.repeat(32) }))[0].uname, 'x'.repeat(32))
    assert.equal(unpack(one({ name: 'a', gname: 'ü' }))[0].gname, 'ü')
    assert.equal(unpack(one({ name: 'l', type: 'symlink', linkname: 'x'.repeat(101) }))[0].linkname, 'x'.repeat(101))
  })
})

describe('the options', () => {
  it('refuses a format or a blocking it does not know', () => {
    assert.throws(() => pack([], { format: 'zip' }), /format "zip" is not gnu, ustar or pax/u)
    assert.throws(() => pack([], { blocking: 0 }), /blocking is not a positive integer/u)
    assert.throws(() => pack([], { blocking: 1.5 }), /blocking is not a positive integer/u)
  })
  it('pads to the record size, 20 blocks by default as tar does', () => {
    assert.equal(pack([{ name: 'a' }]).length, 10240)
    assert.equal(pack([{ name: 'a' }], { blocking: 1 }).length, 1536)
    assert.equal(pack([{ name: 'a' }], { blocking: 2 }).length, 2048)
    assert.equal(pack([{ name: 'a' }], { blocking: 3 }).length, 1536)
    assert.equal(pack([], { blocking: 1 }).length, 1024)
  })
  it('takes any iterable of entries and nothing else', () => {
    const entries = function* entries() {
      yield { name: 'a' }
      yield { name: 'b' }
    }
    assert.equal(unpack(pack(entries())).length, 2)
    assert.throws(() => pack({ name: 'a' }), TypeError)
    assert.throws(() => pack(null), TypeError)
  })
  it('fills in what an entry leaves out the way tar sees it on disk', () => {
    const [file, dir, link] = unpack(pack([{ name: 'a' }, { name: 'd', type: 'directory' }, { name: 'l', type: 'symlink', linkname: 'a' }]))
    assert.deepEqual([file.mode, dir.mode, link.mode], [0o644, 0o755, 0o777])
    assert.deepEqual([file.uid, file.gid, file.mtime, file.uname, file.gname, file.linkname, file.devmajor, file.devminor], [0, 0, 0, '', '', '', 0, 0])
    assert.equal(file.data.length, 0)
  })
})
