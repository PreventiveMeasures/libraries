import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Names, checkSymlinkTarget, cleanNames, cleanPath } from '../src/names.js'
import { utf8 } from './helpers.js'

// The rules a name is held to, on their own: what is a clean relative
// path, where a symlink may point, and what the record of names refuses.

describe('a name is a clean relative path', () => {
  for (const name of ['a', 'a/b', 'a.b/c-d_e', 'ü/日本', 'a b', 'a/..b', 'a/b..', '...', 'ab:c', 'a/b:c', 'file..txt']) {
    it(`accepts ${JSON.stringify(name)}`, () => assert.equal(cleanPath(name, 'name'), name))
  }
  it('drops . segments, and a directory\'s trailing slash', () => {
    assert.equal(cleanPath('./a', 'name'), 'a')
    assert.equal(cleanPath('a/./b/.', 'name'), 'a/b')
    assert.equal(cleanPath('d/', 'name', true), 'd')
    assert.equal(cleanPath('./d/./', 'name', true), 'd')
  })
  it('names the archive root ., for a directory only', () => {
    assert.equal(cleanPath('.', 'name', true), '.')
    assert.equal(cleanPath('./', 'name', true), '.')
    assert.equal(cleanPath('././', 'name', true), '.')
    assert.throws(() => cleanPath('.', 'name'), /name "\." names the archive root but is not a directory/u)
    assert.throws(() => cleanPath('./', 'name'), /ends in a slash but is not a directory/u)
    assert.throws(() => cleanPath('././.', 'name'), /names the archive root but is not a directory/u)
  })
  const refused = [
    ['', /is empty/u],
    ['/a', /is absolute/u],
    ['/', /is absolute/u],
    ['C:/a', /starts with a drive letter/u],
    ['c:a', /starts with a drive letter/u],
    ['C:', /starts with a drive letter/u],
    ['a/', /"a\/" ends in a slash but is not a directory/u],
    ['a//b', /empty segment/u],
    ['a/./b//c', /empty segment/u],
    ['a/../b', /has a \.\. segment/u],
    ['..', /has a \.\. segment/u],
    ['./..', /has a \.\. segment/u],
    ['a\\b', /control character or a backslash/u],
    ['a\nb', /control character or a backslash/u],
    ['a\u0000', /control character or a backslash/u],
    ['a\u007F', /control character or a backslash/u],
  ]
  for (const [name, message] of refused) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      assert.throws(() => cleanPath(name, 'name'), message)
      if (name !== 'a/') assert.throws(() => cleanPath(name, 'name', true), message)
    })
  }
  it('refuses a lone surrogate before measuring anything', () => {
    assert.throws(() => cleanPath('a\uD800', 'name'), /name is not well-formed Unicode/u)
    assert.throws(() => checkSymlinkTarget('l', '\uDC00'), /symlink target of "l" is not well-formed Unicode/u)
  })
  it('refuses C1 controls as it does C0 ones', () => {
    assert.throws(() => cleanPath('a\u0085b', 'name'), /control character/u)
    assert.throws(() => cleanPath('a\u009Bb', 'name'), /control character/u)
    cleanPath('a\u00A0b', 'name')
  })
  it('refuses what no filesystem takes: a segment over 255 bytes, a path over 4096', () => {
    cleanPath('x'.repeat(255), 'name')
    assert.throws(() => cleanPath('x'.repeat(256), 'name'), /has a segment longer than 255 bytes/u)
    assert.throws(() => cleanPath('ü'.repeat(128), 'name'), /has a segment longer than 255 bytes/u)
    cleanPath(Array.from({ length: 16 }, () => 'x'.repeat(255)).join('/'), 'name')
    assert.throws(() => cleanPath(Array.from({ length: 17 }, () => 'x'.repeat(255)).join('/'), 'name'), /is longer than 4096 bytes/u)
    assert.throws(() => checkSymlinkTarget('l', 'x'.repeat(256)), /has a segment longer than 255 bytes/u)
  })
  it('names what it was checking', () => {
    assert.throws(() => cleanPath(42, 'hard link target'), /hard link target is not a string/u)
    assert.throws(() => cleanPath('/x', 'entry name'), /entry name "\/x" is absolute/u)
  })
})

describe('a symlink target stays inside the archive', () => {
  const fine = [['l', 'a'], ['a/b/l', '../c'], ['a/b/l', '../../c'], ['a/l', './x'], ['a/l', 'x/'], ['l', 'a/../b'], ['a/l', 'x//y'], ['l', 'a/b/../../c']]
  for (const [name, target] of fine) {
    it(`${name} -> ${target}`, () => checkSymlinkTarget(name, target))
  }
  const refused = [
    ['l', '../x', /points outside the archive/u],
    ['a/l', '../../x', /points outside the archive/u],
    ['l', 'a/../../x', /points outside the archive/u],
    ['l', '/etc/passwd', /is absolute/u],
    ['l', 'C:/x', /starts with a drive letter/u],
    ['l', 'C:x', /starts with a drive letter/u],
    ['l', '', /is empty/u],
    ['l', 'a\\b', /control character or a backslash/u],
    ['l', 42, /is not a string/u],
  ]
  for (const [name, target, message] of refused) {
    it(`refuses ${name} -> ${JSON.stringify(target)}`, () => assert.throws(() => checkSymlinkTarget(name, target), message))
  }
})

describe('the names seen so far', () => {
  const entry = (name, type = 'file', linkname = '', over = {}) => ({
    name, type, linkname, mode: 0o644, uid: 0, gid: 0, mtime: 0, uname: '', gname: '', devmajor: 0, devminor: 0, data: new Uint8Array(0), ...over,
  })
  const after = (...entries) => {
    const names = new Names(true)
    for (const e of entries) names.add(e)
    return names
  }
  it('takes a name twice only as the same entry again', () => {
    after(entry('a')).add(entry('a'))
    after(entry('a', 'file', '', { data: utf8('x') })).add(entry('a', 'file', '', { data: utf8('x') }))
    after(entry('d', 'directory')).add(entry('d', 'directory'))
    after(entry('a'), entry('l', 'symlink', 'a')).add(entry('l', 'symlink', 'a'))
    assert.throws(() => after(entry('a', 'file', '', { data: utf8('x') })).add(entry('a', 'file', '', { data: utf8('y') })), /duplicate entry "a" differs in data/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { data: utf8('x') })), /duplicate entry "a" differs in data/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { mtime: 1 })), /duplicate entry "a" differs in mtime/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { mode: 0o600 })), /differs in mode/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { uname: 'me' })), /differs in uname/u)
    assert.throws(() => after(entry('a'), entry('l', 'symlink', 'a')).add(entry('l', 'symlink', './a')), /differs in linkname/u)
  })
  it('compares a repeat by its fields alone when told to keep nothing, and refuses what it cannot compare', () => {
    const names = new Names()
    names.add(entry('a', 'file', '', { data: utf8('x') }))
    assert.throws(() => names.add(entry('a', 'file', '', { mtime: 1 })), /duplicate entry "a" differs in mtime/u)
    assert.throws(() => names.add(entry('a', 'file', '', { data: utf8('x') })), /duplicate entry "a", which only the in-memory call can compare with the earlier one/u)
  })
  it('refuses a file and a directory of one name, either way round', () => {
    assert.throws(() => after(entry('a')).add(entry('a', 'directory')), /duplicate entry "a" differs in type/u)
    assert.throws(() => after(entry('a', 'directory')).add(entry('a')), /duplicate entry "a" differs in type/u)
  })
  it('lets a directory be named after what it already held', () => {
    after(entry('a/b')).add(entry('a', 'directory'))
  })
  it('refuses a file named like the directory of an earlier entry', () => {
    assert.throws(() => after(entry('a/b')).add(entry('a')), /"a" holds an earlier entry, so it cannot be a file/u)
    assert.throws(() => after(entry('a/b')).add(entry('a', 'symlink', 'x')), /cannot be a symlink/u)
  })
  it('refuses an entry inside something that is not a directory', () => {
    assert.throws(() => after(entry('a')).add(entry('a/b')), /"a\/b" is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a', 'symlink', 'elsewhere')).add(entry('a/b')), /is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a', 'fifo')).add(entry('a/b/c', 'directory')), /is inside "a"/u)
  })
  it('lets a hard link name an earlier non-directory entry', () => {
    after(entry('a')).add(entry('b', 'link', 'a'))
    after(entry('a', 'symlink', 'x')).add(entry('b', 'link', 'a'))
  })
  it('refuses a hard link to anything else', () => {
    assert.throws(() => after().add(entry('b', 'link', 'a')), /hard link "b" targets "a", which is not an earlier non-directory entry/u)
    assert.throws(() => after(entry('a', 'directory')).add(entry('b', 'link', 'a')), /not an earlier non-directory entry/u)
    assert.throws(() => after(entry('a/x')).add(entry('b', 'link', 'a')), /not an earlier non-directory entry/u)
    assert.throws(() => after().add(entry('b', 'link', 'b')), /not an earlier non-directory entry/u)
  })
  it('cleanNames runs every check in order, and hands back the cleaned names', () => {
    assert.deepEqual(cleanNames('./a', 'file', ''), { name: 'a', linkname: '' })
    assert.throws(() => cleanNames('../b', 'file', ''), /\.\. segment/u)
    assert.throws(() => cleanNames('l', 'symlink', '../x'), /points outside/u)
    assert.throws(() => cleanNames('h', 'link', '/a'), /hard link target of "h" "\/a" is absolute/u)
    assert.deepEqual(cleanNames('h', 'link', './a'), { name: 'h', linkname: 'a' })
    assert.deepEqual(cleanNames('./', 'directory', ''), { name: '.', linkname: '' })
    assert.deepEqual(cleanNames('./d/', 'directory', ''), { name: 'd', linkname: '' })
  })
})
