import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Names, checkSymlinkTarget, cleanNames, cleanPath } from '../src/names.js'
import { utf8 } from './helpers.js'

// The name rules, the same as tar's: what is a clean relative path, where a
// symlink may point, and what the record of names refuses.

describe('a name is a clean relative path', () => {
  for (const name of ['a', 'a/b', 'a.b/c-d_e', 'ü/日本', 'a b', 'a/..b', 'file..txt', '...', 'a:b']) {
    it(`accepts ${JSON.stringify(name)}`, () => assert.equal(cleanPath(name, 'name'), name))
  }
  it('drops . segments, and a directory\'s trailing slash', () => {
    assert.equal(cleanPath('./a', 'name'), 'a')
    assert.equal(cleanPath('a/./b/.', 'name'), 'a/b')
    assert.equal(cleanPath('d/', 'name', true), 'd')
    assert.equal(cleanPath('.', 'name', true), '.')
    assert.throws(() => cleanPath('.', 'name'), /names the archive root but is not a directory/u)
  })
  const refused = [
    ['', /is empty/u],
    ['/a', /is absolute/u],
    ['a/', /ends in a slash but is not a directory/u],
    ['a//b', /empty segment/u],
    ['a/../b', /has a \.\. segment/u],
    ['..', /has a \.\. segment/u],
    ['a\\b', /control character or a backslash/u],
    ['a\nb', /control character or a backslash/u],
    ['a\u0085b', /control character or a backslash/u],
    ['a\uD800', /is not well-formed Unicode/u],
    ['x'.repeat(256), /has a segment longer than 255 bytes/u],
  ]
  for (const [name, message] of refused) {
    it(`refuses ${JSON.stringify(name)}`, () => assert.throws(() => cleanPath(name, 'name'), message))
  }
})

describe('a symlink target stays inside the archive', () => {
  for (const [name, target] of [['l', 'a'], ['a/b/l', '../c'], ['a/b/l', '../../c'], ['a/l', './x'], ['l', 'a/../b']]) {
    it(`${name} -> ${target}`, () => checkSymlinkTarget(name, target))
  }
  for (const [name, target, message] of [['l', '../x', /points outside the archive/u], ['a/l', '../../x', /points outside the archive/u], ['l', '/etc/passwd', /is absolute/u], ['l', '', /is empty/u]]) {
    it(`refuses ${name} -> ${JSON.stringify(target)}`, () => assert.throws(() => checkSymlinkTarget(name, target), message))
  }
})

describe('the names seen so far', () => {
  const entry = (name, type = 'file', linkname = '', over = {}) => ({ name, type, linkname, mode: 0o644, mtime: 0, data: new Uint8Array(0), ...over })
  const after = (...entries) => {
    const names = new Names()
    for (const e of entries) names.add(e)
    return names
  }
  it('takes a name twice only as the same entry again', () => {
    after(entry('a')).add(entry('a'))
    after(entry('a', 'file', '', { data: utf8('x') })).add(entry('a', 'file', '', { data: utf8('x') }))
    assert.throws(() => after(entry('a', 'file', '', { data: utf8('x') })).add(entry('a', 'file', '', { data: utf8('y') })), /duplicate entry "a" differs in data/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { mtime: 1 })), /duplicate entry "a" differs in mtime/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'file', '', { mode: 0o600 })), /differs in mode/u)
    assert.throws(() => after(entry('a')).add(entry('a', 'directory')), /differs in type/u)
    assert.throws(() => after(entry('a'), entry('l', 'symlink', 'a')).add(entry('l', 'symlink', './a')), /differs in linkname/u)
  })
  it('refuses an entry inside something that is not a directory, and a file over an implied directory', () => {
    assert.throws(() => after(entry('a')).add(entry('a/b')), /"a\/b" is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a', 'symlink', 'x')).add(entry('a/b')), /is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a/b')).add(entry('a')), /"a" holds an earlier entry, so it cannot be a file/u)
    after(entry('a/b')).add(entry('a', 'directory'))
  })
  it('cleanNames hands back the cleaned names', () => {
    assert.deepEqual(cleanNames('./a', 'file', ''), { name: 'a', linkname: '' })
    assert.deepEqual(cleanNames('./d/', 'directory', ''), { name: 'd', linkname: '' })
    assert.deepEqual(cleanNames('l', 'symlink', 'a/../b'), { name: 'l', linkname: 'a/../b' })
    assert.throws(() => cleanNames('l', 'symlink', '../x'), /points outside/u)
  })
})
