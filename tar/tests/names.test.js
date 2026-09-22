import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Names, admit, checkPath, checkSymlinkTarget } from '../src/names.js'

// The rules a name is held to, on their own: what is a clean relative
// path, where a symlink may point, and what the record of names refuses.

describe('a name is a clean relative path', () => {
  for (const name of ['a', 'a/b', 'a.b/c-d_e', 'ü/日本', 'a b', 'a/..b', 'a/b..', '...', 'a:b']) {
    it(`accepts ${JSON.stringify(name)}`, () => checkPath(name, 'name'))
  }
  const refused = [
    ['', /is empty/u],
    ['/a', /is absolute/u],
    ['a/', /empty segment/u],
    ['a//b', /empty segment/u],
    ['./a', /has a \. segment/u],
    ['.', /has a \. segment/u],
    ['a/../b', /has a \.\. segment/u],
    ['..', /has a \.\. segment/u],
    ['a\\b', /control character or a backslash/u],
    ['a\nb', /control character or a backslash/u],
    ['a\u0000', /control character or a backslash/u],
    ['a\u007F', /control character or a backslash/u],
  ]
  for (const [name, message] of refused) {
    it(`refuses ${JSON.stringify(name)}`, () => assert.throws(() => checkPath(name, 'name'), message))
  }
  it('refuses C1 controls as it does C0 ones', () => {
    assert.throws(() => checkPath('a\u0085b', 'name'), /control character/u)
    assert.throws(() => checkPath('a\u009Bb', 'name'), /control character/u)
    checkPath('a\u00A0b', 'name')
  })
  it('refuses what no filesystem takes: a segment over 255 bytes, a path over 4096', () => {
    checkPath('x'.repeat(255), 'name')
    assert.throws(() => checkPath('x'.repeat(256), 'name'), /has a segment longer than 255 bytes/u)
    assert.throws(() => checkPath('ü'.repeat(128), 'name'), /has a segment longer than 255 bytes/u)
    checkPath(Array.from({ length: 16 }, () => 'x'.repeat(255)).join('/'), 'name')
    assert.throws(() => checkPath(Array.from({ length: 17 }, () => 'x'.repeat(255)).join('/'), 'name'), /is longer than 4096 bytes/u)
    assert.throws(() => checkSymlinkTarget('l', 'x'.repeat(256)), /has a segment longer than 255 bytes/u)
  })
  it('names what it was checking', () => {
    assert.throws(() => checkPath(42, 'hard link target'), /hard link target is not a string/u)
    assert.throws(() => checkPath('/x', 'entry name'), /entry name "\/x" is absolute/u)
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
    ['l', '', /is empty/u],
    ['l', 'a\\b', /control character or a backslash/u],
    ['l', 42, /is not a string/u],
  ]
  for (const [name, target, message] of refused) {
    it(`refuses ${name} -> ${JSON.stringify(target)}`, () => assert.throws(() => checkSymlinkTarget(name, target), message))
  }
})

describe('the names seen so far', () => {
  const after = (...entries) => {
    const names = new Names()
    for (const [name, type, linkname] of entries) names.add(name, type, linkname)
    return names
  }
  it('refuses a name twice', () => {
    assert.throws(() => after(['a', 'file']).add('a', 'file'), /duplicate entry "a"/u)
    assert.throws(() => after(['a', 'directory']).add('a', 'directory'), /duplicate entry "a"/u)
  })
  it('refuses a file and a directory of one name, either way round', () => {
    assert.throws(() => after(['a', 'file']).add('a', 'directory'), /duplicate entry "a"/u)
    assert.throws(() => after(['a', 'directory']).add('a', 'file'), /duplicate entry "a"/u)
  })
  it('lets a directory be named after what it already held', () => {
    after(['a/b', 'file']).add('a', 'directory')
  })
  it('refuses a file named like the directory of an earlier entry', () => {
    assert.throws(() => after(['a/b', 'file']).add('a', 'file'), /"a" holds an earlier entry, so it cannot be a file/u)
    assert.throws(() => after(['a/b', 'file']).add('a', 'symlink', 'x'), /cannot be a symlink/u)
  })
  it('refuses an entry inside something that is not a directory', () => {
    assert.throws(() => after(['a', 'file']).add('a/b', 'file'), /"a\/b" is inside "a", which is not a directory/u)
    assert.throws(() => after(['a', 'symlink', 'elsewhere']).add('a/b', 'file'), /is inside "a", which is not a directory/u)
    assert.throws(() => after(['a', 'fifo']).add('a/b/c', 'directory'), /is inside "a"/u)
  })
  it('lets a hard link name an earlier non-directory entry', () => {
    after(['a', 'file']).add('b', 'link', 'a')
    after(['a', 'symlink', 'x']).add('b', 'link', 'a')
  })
  it('refuses a hard link to anything else', () => {
    assert.throws(() => after().add('b', 'link', 'a'), /hard link "b" targets "a", which is not an earlier non-directory entry/u)
    assert.throws(() => after(['a', 'directory']).add('b', 'link', 'a'), /not an earlier non-directory entry/u)
    assert.throws(() => after(['a/x', 'file']).add('b', 'link', 'a'), /not an earlier non-directory entry/u)
    assert.throws(() => after().add('b', 'link', 'b'), /not an earlier non-directory entry/u)
  })
  it('admit runs every check in order', () => {
    const names = new Names()
    admit(names, 'a', 'file', '')
    assert.throws(() => admit(names, 'a', 'file', ''), /duplicate/u)
    assert.throws(() => admit(names, '../b', 'file', ''), /\.\. segment/u)
    assert.throws(() => admit(names, 'l', 'symlink', '../x'), /points outside/u)
    assert.throws(() => admit(names, 'h', 'link', '/a'), /hard link target of "h" "\/a" is absolute/u)
    admit(names, 'h', 'link', 'a')
  })
})
