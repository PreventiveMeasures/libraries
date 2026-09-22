import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BLOCK, EMPTY, decodeHeader, encodeHeader, fitsOctal, octalMax, readNumber, writeNumber } from '../src/header.js'
import { encodePax } from '../src/pax.js'
import { assertBytes, utf8 } from './helpers.js'

// The header block on its own: how a number is written in each of its
// forms and read back, and that a header reads back as what it was.

const fields = (over) => ({
  gnu: false, name: utf8('a'), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
  typeflag: 0x30, mode: 0o644, uid: 0, gid: 0, size: 0, mtime: 0, devmajor: null, devminor: null, ...over,
})

const latin1 = (text) => Uint8Array.from(text, (c) => c.codePointAt(0))

describe('numbers', () => {
  it('fit in octal one digit short of the field', () => {
    assert.equal(octalMax(8), 2097151)
    assert.equal(octalMax(12), 8589934591)
    assert.ok(fitsOctal(2097151, 8))
    assert.ok(!fitsOctal(2097152, 8))
    assert.ok(!fitsOctal(-1, 8))
  })
  it('are written as digits and a NUL', () => {
    const block = new Uint8Array(12)
    writeNumber(block, 0, 8, 0o644, false)
    assertBytes(block.subarray(0, 8), latin1('0000644\0'))
    writeNumber(block, 0, 12, 6, false)
    assertBytes(block, latin1('00000000006\0'))
  })
  it('round-trip through every form gnu has', () => {
    for (const [value, size] of [[0, 8], [1, 12], [2097151, 8], [2097152, 8], [8589934591, 12], [8589934592, 12], [Number.MAX_SAFE_INTEGER, 12], [-1, 12], [-(2 ** 40), 12], [3000000, 8]]) {
      const block = new Uint8Array(size)
      writeNumber(block, 0, size, value, true)
      assert.equal(readNumber(block, 0, size, 'field', 0), value, `${value} in ${size}`)
      if (!fitsOctal(value, size)) assert.equal(block[0], value < 0 ? 0xff : 0x80)
    }
  })
  it('write what tar wrote for the values recorded from it', () => {
    const block = new Uint8Array(12)
    writeNumber(block, 0, 8, 3000000, true)
    assertBytes(block.subarray(0, 8), Uint8Array.from([0x80, 0, 0, 0, 0, 0x2d, 0xc6, 0xc0]))
    writeNumber(block, 0, 12, 8589934592, true)
    assertBytes(block, Uint8Array.from([0x80, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0]))
    writeNumber(block, 0, 12, -1, true)
    assertBytes(block, new Uint8Array(12).fill(0xff))
  })
  it('have only octal outside gnu', () => {
    assert.throws(() => writeNumber(new Uint8Array(8), 0, 8, 2097152, false), /does not fit an octal field of 7 digits/u)
    assert.throws(() => writeNumber(new Uint8Array(12), 0, 12, -1, false), /does not fit/u)
  })
  it('read back what older tars wrote', () => {
    assert.equal(readNumber(latin1('   644  '), 0, 8, 'mode', 0), 0o644)
    assert.equal(readNumber(latin1('0000644 '), 0, 8, 'mode', 0), 0o644)
    assert.equal(readNumber(latin1('644\0\0\0\0\0'), 0, 8, 'mode', 0), 0o644)
  })
  it('refuse what is not a number', () => {
    assert.throws(() => readNumber(latin1('        '), 0, 8, 'uid', 512), /the uid field is not an octal number at byte 512/u)
    assert.throws(() => readNumber(new Uint8Array(8), 0, 8, 'uid', 0), /is not an octal number/u)
    assert.throws(() => readNumber(latin1('00006x4\0'), 0, 8, 'uid', 0), /the uid field is not an octal number/u)
    assert.throws(() => readNumber(latin1('0000098\0'), 0, 8, 'uid', 0), /is not an octal number/u)
    assert.throws(() => readNumber(Uint8Array.from([0x81, 0, 0, 0, 0, 0, 0, 1]), 0, 8, 'uid', 0), /is not an octal number/u)
    const huge = new Uint8Array(12).fill(0xff)
    huge[0] = 0x80
    assert.throws(() => readNumber(huge, 0, 12, 'size', 0), /the size field is too large/u)
  })
})

describe('a header', () => {
  it('reads back as what it was', () => {
    const block = encodeHeader(fields({ name: utf8('dir/a.txt'), size: 6, mtime: 1577836800, uid: 7, gid: 8, uname: utf8('me'), gname: utf8('us') }))
    assert.equal(block.length, BLOCK)
    const read = decodeHeader(block, 0)
    assert.equal(read.gnu, false)
    assert.equal(read.typeflag, 0x30)
    assertBytes(read.name, utf8('dir/a.txt'))
    assert.equal(read.size, 6)
    assert.equal(read.mtime, 1577836800)
    assert.equal(read.uid, 7)
    assert.equal(read.gid, 8)
    assert.equal(read.mode, 0o644)
    assertBytes(read.uname, utf8('me'))
    assertBytes(read.gname, utf8('us'))
    assertBytes(read.linkname, EMPTY)
    assertBytes(read.prefix, EMPTY)
  })
  it('carries the checksum tar writes: six digits, a NUL and a space', () => {
    const block = encodeHeader(fields())
    assert.equal(block[148 + 6], 0)
    assert.equal(block[148 + 7], 0x20)
    assert.match(String.fromCodePoint(...block.subarray(148, 154)), /^[0-7]{6}$/u)
  })
  it('refuses a corrupted block', () => {
    const block = encodeHeader(fields())
    block[3] ^= 1
    assert.throws(() => decodeHeader(block, 1024), /header checksum does not match at byte 1024/u)
  })
  it('tells the two magics apart and refuses any other', () => {
    assert.equal(decodeHeader(encodeHeader(fields({ gnu: true })), 0).gnu, true)
    const block = encodeHeader(fields())
    block.set(utf8('ustar\0\0\0'), 257)
    block.fill(0x20, 148, 156)
    const sum = block.reduce((a, b) => a + b, 0)
    block.set(utf8(sum.toString(8).padStart(6, '0')), 148)
    block[154] = 0
    assert.throws(() => decodeHeader(block, 0), /not in the ustar, pax or gnu format/u)
  })
  it('reads the prefix only under the ustar magic', () => {
    const prefixed = fields({ prefix: utf8('p') })
    assertBytes(decodeHeader(encodeHeader(prefixed), 0).prefix, utf8('p'))
    assertBytes(decodeHeader(encodeHeader({ ...prefixed, gnu: true }), 0).prefix, EMPTY)
  })
  it('reads device numbers only for a device, since the fields are NUL otherwise', () => {
    assert.equal(decodeHeader(encodeHeader(fields()), 0).devmajor, 0)
    const device = decodeHeader(encodeHeader(fields({ typeflag: 0x33, devmajor: 1, devminor: 3 })), 0)
    assert.equal(device.devmajor, 1)
    assert.equal(device.devminor, 3)
    assert.throws(() => decodeHeader(encodeHeader(fields({ typeflag: 0x33 })), 0), /the devmajor field is not an octal number/u)
  })
  it('takes a name that fills its field with no NUL', () => {
    const name = utf8('n'.repeat(100))
    assertBytes(decodeHeader(encodeHeader(fields({ name })), 0).name, name)
  })
})

describe('pax records', () => {
  it('count their own length, as tar does', () => {
    assertBytes(encodePax([['size', '8589934592']]), utf8('19 size=8589934592\n'))
    assertBytes(encodePax([['uid', '3000000'], ['gid', '3000000']]), utf8('15 uid=3000000\n15 gid=3000000\n'))
    // 97 bytes of record and two digits is 99; one more byte needs three
    // digits, and with them the total skips 100 — as it does in tar.
    assertBytes(encodePax([['path', 'x'.repeat(90)]]), utf8(`99 path=${'x'.repeat(90)}\n`))
    assertBytes(encodePax([['path', 'x'.repeat(91)]]), utf8(`101 path=${'x'.repeat(91)}\n`))
    assertBytes(encodePax([['path', 'x'.repeat(92)]]), utf8(`102 path=${'x'.repeat(92)}\n`))
  })
})
