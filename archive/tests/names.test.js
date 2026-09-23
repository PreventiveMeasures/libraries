import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Names, checkSymlinkTarget, cleanNames, cleanPath } from '../src/names.js'
import { quote } from '../src/text.js'
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
  it('lands every spelling of a path on one name', () => {
    for (const spelling of ['a/b', './a/b', 'a/./b', './a/./b/.', 'a/b/.']) assert.equal(cleanPath(spelling, 'name'), 'a/b')
    for (const spelling of ['d', 'd/', './d', 'd/.', 'd/./', './d/./']) assert.equal(cleanPath(spelling, 'name', true), 'd')
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
    ['./C:/a', /starts with a drive letter/u],
    ['././c:a', /starts with a drive letter/u],
    ['a/', /"a\/" ends in a slash but is not a directory/u],
    ['a//b', /empty segment/u],
    ['a/./b//c', /empty segment/u],
    ['a/../b', /has a \.\. segment/u],
    ['..', /has a \.\. segment/u],
    ['./..', /has a \.\. segment/u],
    ['a\\b', /control or formatting character, or a backslash/u],
    ['a\nb', /control or formatting character, or a backslash/u],
    ['a\u0000', /control or formatting character, or a backslash/u],
    ['a\u007F', /control or formatting character, or a backslash/u],
    ['a\u202Eb', /control or formatting character, or a backslash/u],
    ['a\u2066b', /control or formatting character, or a backslash/u],
    ['a\u2028b', /control or formatting character, or a backslash/u],
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
    assert.throws(() => cleanPath('a\u0085b', 'name'), /control or formatting character/u)
    assert.throws(() => cleanPath('a\u009Bb', 'name'), /control or formatting character/u)
    cleanPath('a\u00A0b', 'name')
  })
  it('refuses what no filesystem takes: a segment over 255 bytes, a path over 4096', () => {
    cleanPath('x'.repeat(255), 'name')
    assert.throws(() => cleanPath('x'.repeat(256), 'name'), /has a segment longer than 255 bytes/u)
    assert.throws(() => cleanPath('ü'.repeat(128), 'name'), /has a segment longer than 255 bytes/u)
    cleanPath(Array.from({ length: 16 }, () => 'x'.repeat(255)).join('/'), 'name')
    assert.throws(() => cleanPath(Array.from({ length: 17 }, () => 'x'.repeat(255)).join('/'), 'name'), /is longer than 4096 bytes/u)
    assert.throws(() => checkSymlinkTarget('l', 'x'.repeat(256)), /has a segment longer than 255 bytes/u)
    const longest = `${Array.from({ length: 15 }, () => 'x'.repeat(255)).join('/')}/${'x'.repeat(200)}/${'x'.repeat(55)}`
    assert.equal(utf8(longest).length, 4096)
    cleanPath(longest, 'name')
    assert.throws(() => cleanPath(longest, 'name', true), /is longer than 4096 bytes/u, 'a directory is stored with its slash')
    assert.equal(cleanPath(`${longest.slice(0, -1)}/`, 'name', true), longest.slice(0, -1))
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
  // The steps, not the paths they stand on: spelling out every path of a
  // deep walk costs its depth squared. What each step has to find is the
  // record of names' to say, below.
  it('hands back the steps the walk takes, empty and . segments dropped', () => {
    assert.deepEqual(checkSymlinkTarget('l', 'x'), ['x'])
    assert.deepEqual(checkSymlinkTarget('a/l', '../b/c/d'), ['..', 'b', 'c', 'd'])
    assert.deepEqual(checkSymlinkTarget('l', 'a/./b//c/..'), ['a', 'b', 'c', '..'])
    assert.deepEqual(checkSymlinkTarget('a/b/l', '../../x/y'), ['..', '..', 'x', 'y'])
    assert.deepEqual(checkSymlinkTarget('a/b/l', '../c'), ['..', 'c'])
  })
  const refused = [
    ['l', '../x', /points outside the archive/u],
    ['a/l', '../../x', /points outside the archive/u],
    ['l', 'a/../../x', /points outside the archive/u],
    ['l', '/etc/passwd', /is absolute/u],
    ['l', 'C:/x', /starts with a drive letter/u],
    ['l', 'C:x', /starts with a drive letter/u],
    ['l', './C:/x', /starts with a drive letter/u],
    ['l', '', /is empty/u],
    ['l', 'a\\b', /control or formatting character, or a backslash/u],
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
    assert.throws(() => after(entry('a/b')).add(entry('a')), /"a" is already a directory, so it cannot be a file/u)
    assert.throws(() => after(entry('a/b')).add(entry('a', 'symlink', 'x')), /cannot be a symlink/u)
  })
  it('refuses an entry inside something that is not a directory', () => {
    assert.throws(() => after(entry('a')).add(entry('a/b')), /"a\/b" is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a', 'symlink', 'elsewhere')).add(entry('a/b')), /is inside "a", which is not a directory/u)
    assert.throws(() => after(entry('a', 'fifo')).add(entry('a/b/c', 'directory')), /is inside "a"/u)
  })
  it('costs a tree the length of its names, and names the parent that is not a directory at any depth', () => {
    const names = new Names(true)
    let path = ''
    const t0 = performance.now()
    for (let i = 0; i < 2047; i++) {
      path += i === 0 ? 'a' : '/a'
      names.add(entry(path, 'directory'))
    }
    names.add(entry(`${path}/f`))
    assert.ok(performance.now() - t0 < 1000, 'two thousand nested directories took a second or more')
    assert.throws(() => names.add(entry(`${path}/f/x`)), { message: `${quote(`${path}/f/x`)} is inside ${quote(`${path}/f`)}, which is not a directory` })
    assert.throws(() => after(entry('f')).add(entry(`f/${'a/'.repeat(100)}x`)), /is inside "f", which is not a directory/u)
    assert.throws(() => after(entry('d/f')).add(entry(`d/f/${'a/'.repeat(100)}x`)), /is inside "d\/f", which is not a directory/u)
  })
  it('refuses a symlink target that walks through anything but a directory, whichever comes first', () => {
    // d/s is the archive root, so d/s/.. would be its parent.
    assert.throws(() => after(entry('d/s', 'symlink', '..')).add(entry('l', 'symlink', 'd/s/..')), /the target of symlink "l" passes through "d\/s", which is not a directory/u)
    assert.throws(() => after(entry('l', 'symlink', 'd/s/../x')).add(entry('d/s', 'symlink', '..')), /"d\/s" is already a directory, so it cannot be a symlink/u)
    assert.throws(() => after(entry('f')).add(entry('l', 'symlink', 'f/..')), /passes through "f", which is not a directory/u)
    assert.throws(() => after().add(entry('l', 'symlink', 'l/x')), /passes through "l", which is not a directory/u)
    assert.throws(() => after(entry('l', 'symlink', 'a/x')).add(entry('a')), /"a" is already a directory, so it cannot be a file/u)
  })
  it('holds every path a symlink target stands on short of its end to being a directory', () => {
    // The link, its target, the paths it walks through that are not the
    // link's own directories, and where it ends where that is a new segment,
    // which may be anything at all.
    const walks = [
      ['l', 'x', [], 'x'],
      ['a/l', '../b/c/d', ['b', 'b/c'], 'b/c/d'],
      ['l', 'a/./b//c/..', ['a', 'a/b', 'a/b/c'], null],
      ['a/b/l', '../../x/y', ['x'], 'x/y'],
      ['a/b/l', '../c', [], 'a/c'],
    ]
    for (const [link, target, through, end] of walks) {
      for (const path of through) {
        assert.throws(() => after(entry(path)).add(entry(link, 'symlink', target)), (error) => error.message === `the target of symlink ${JSON.stringify(link)} passes through ${JSON.stringify(path)}, which is not a directory`)
      }
      if (end !== null) after(entry(end)).add(entry(link, 'symlink', target))
    }
  })
  it('holds the directory a walk comes back out into to being one too', () => {
    // A symlink's own directories are always that already; a hard link's are
    // not yet when its walk runs, so this is where the rule shows: f/h walks
    // y/../z from f, stands on f/y and then on f, and f is a file.
    assert.throws(() => after(entry('f'), entry('s', 'symlink', 'y/../z')).add(entry('f/h', 'link', 's')), /the target of hard link "f\/h" to symlink "s" passes through "f", which is not a directory/u)
  })
  it('lets a symlink point at another, or walk up through its own directories', () => {
    after(entry('a', 'symlink', 'b')).add(entry('l', 'symlink', 'a'))
    after(entry('d/s', 'symlink', '..')).add(entry('d/l', 'symlink', '../d/s'))
    after(entry('l', 'symlink', 'a/x')).add(entry('a', 'directory'))
  })
  it('lets a hard link name an earlier non-directory entry', () => {
    after(entry('a')).add(entry('b', 'link', 'a'))
    after(entry('a', 'symlink', 'x')).add(entry('b', 'link', 'a'))
  })
  it('walks a hard link to a symlink from the link\'s own name', () => {
    // a/b/s -> ../x lands inside the archive; the same symlink reached as h,
    // at the root, lands outside it, and tar gives h that very target.
    assert.throws(() => after(entry('a/b/s', 'symlink', '../x')).add(entry('h', 'link', 'a/b/s')), /symlink "h" points outside the archive, to "\.\.\/x"/u)
    // d/s -> g/x walks through d/g, which nothing says is not a directory;
    // reached as h it walks through g, which is a file.
    assert.throws(() => after(entry('g'), entry('d/s', 'symlink', 'g/x')).add(entry('h', 'link', 'd/s')), /the target of hard link "h" to symlink "d\/s" passes through "g", which is not a directory/u)
    // Safe from both places, so both names are taken.
    after(entry('s', 'symlink', 'b')).add(entry('h', 'link', 's'))
    after(entry('d/s', 'symlink', 'x')).add(entry('h', 'link', 'd/s'))
  })
  it('walks a hard link to a hard link to a symlink the same way, however long the chain', () => {
    // a/b/h is a/b/s under a second name, and h2 is it under a third, at the
    // root, where ../x lands outside.
    const chain = [entry('a/b/s', 'symlink', '../x'), entry('a/b/h', 'link', 'a/b/s')]
    assert.throws(() => after(...chain).add(entry('h2', 'link', 'a/b/h')), /symlink "h2" points outside the archive, to "\.\.\/x"/u)
    assert.throws(() => after(...chain, entry('a/b/h2', 'link', 'a/b/h')).add(entry('h3', 'link', 'a/b/h2')), /symlink "h3" points outside the archive/u)
    assert.throws(() => after(entry('g'), entry('d/s', 'symlink', 'g/x'), entry('d/h', 'link', 'd/s')).add(entry('h2', 'link', 'd/h')), /the target of hard link "h2" to symlink "d\/h" passes through "g", which is not a directory/u)
    after(entry('s', 'symlink', 'b'), entry('h', 'link', 's')).add(entry('h2', 'link', 'h'))
    // A chain through a file carries no symlink along it.
    after(entry('f'), entry('d/h', 'link', 'f')).add(entry('h2', 'link', 'd/h'))
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
