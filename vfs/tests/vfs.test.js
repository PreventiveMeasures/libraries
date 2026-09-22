import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Vfs, VfsError, createVfs } from '../vfs.js'

const fails = (fn, code, path) => assert.throws(fn, { name: 'VfsError', code, ...(path === undefined ? {} : { path }) })

describe('files', () => {
  it('are written as text or bytes and read back as either', () => {
    const fs = new Vfs()
    fs.writeFile('/a', 'héllo')
    assert.equal(fs.readText('/a'), 'héllo')
    assert.deepEqual(fs.readFile('/a'), new TextEncoder().encode('héllo'))
    fs.writeFile('/b', new Uint8Array([1, 2, 3]))
    assert.deepEqual(fs.readFile('/b'), new Uint8Array([1, 2, 3]))
    assert.equal(fs.stat('/a').size, 6)
    assert.equal(fs.stat('/b').size, 3)
  })

  it('copy the bytes they are given and hand out the bytes they hold', () => {
    const fs = new Vfs()
    const given = new Uint8Array([1, 2])
    fs.writeFile('/a', given)
    given[0] = 9
    assert.deepEqual(fs.readFile('/a'), new Uint8Array([1, 2]))
    assert.equal(fs.readFile('/a'), fs.readFile('/a'), 'the same array each time')
  })

  it('keep their inode across a rewrite, and are truncated by one', () => {
    const fs = new Vfs()
    fs.writeFile('/a', 'long text')
    const { ino } = fs.stat('/a')
    fs.writeFile('/a', 'x')
    assert.equal(fs.readText('/a'), 'x')
    assert.equal(fs.stat('/a').ino, ino)
  })

  it('take a mode and an mtime, and keep them unless told otherwise', () => {
    const fs = new Vfs()
    fs.writeFile('/a', 'x', { mode: 0o600, mtime: 1234 })
    assert.deepEqual(fs.stat('/a'), { type: 'file', ino: 2, mode: 0o600, mtime: 1234, size: 1 })
    fs.writeFile('/a', 'yy')
    assert.deepEqual(fs.stat('/a'), { type: 'file', ino: 2, mode: 0o600, mtime: 1234, size: 2 })
    fs.writeFile('/a', 'z', { mtime: 5 })
    assert.equal(fs.stat('/a').mtime, 5)
    fs.chmod('/a', 0o755)
    fs.utimes('/a', 99)
    assert.equal(fs.stat('/a').mode, 0o755)
    assert.equal(fs.stat('/a').mtime, 99)
    assert.throws(() => fs.chmod('/a', 0o10000), RangeError)
    assert.throws(() => fs.chmod('/a', -1), RangeError)
    assert.throws(() => fs.chmod('/a'), RangeError)
    assert.throws(() => fs.utimes('/a', 1.5), RangeError)
    assert.throws(() => fs.utimes('/a'), RangeError)
    assert.throws(() => fs.writeFile('/b', 'x', { mode: '644' }), RangeError)
    assert.throws(() => fs.mkdir('/b', { mtime: 'now' }), RangeError)
    assert.equal(fs.stat('/a').mode, 0o755, 'nothing changed under a refused call')
  })

  it('are appended to, and made by an append', () => {
    const fs = new Vfs()
    fs.appendFile('/a', 'ab')
    fs.appendFile('/a', new Uint8Array([99]))
    assert.equal(fs.readText('/a'), 'abc')
    fs.mkdir('/d')
    fails(() => fs.appendFile('/d', 'x'), 'EISDIR')
  })

  it('grow by appends in linear time, and leave bytes handed out earlier as they were', () => {
    const fs = new Vfs()
    fs.writeFile('/log', 'first\n')
    const early = fs.readFile('/log')
    const started = performance.now()
    for (let i = 0; i < 100000; i++) fs.appendFile('/log', 'line\n')
    assert.ok(performance.now() - started < 2000, 'a hundred thousand appends')
    assert.equal(fs.stat('/log').size, 6 + 5 * 100000)
    assert.equal(fs.readText('/log').slice(0, 16), 'first\nline\nline\n')
    assert.deepEqual(early, new TextEncoder().encode('first\n'))
    fs.appendFile('/log', fs.readFile('/log').subarray(0, 6))
    assert.equal(fs.readText('/log').slice(-6), 'first\n')
  })

  it('refuse text with no UTF-8, and bytes that spell no text when read as text', () => {
    const fs = new Vfs()
    fails(() => fs.writeFile('/a', 'lone \uD800 surrogate'), 'EILSEQ', '/a')
    fs.writeFile('/b', new Uint8Array([0x61, 0xFF]))
    fails(() => fs.readText('/b'), 'EILSEQ', '/b')
    assert.throws(() => fs.readText(42), TypeError, 'a wrong type is not a decoding failure')
    assert.throws(() => fs.writeFile('/c', 42), TypeError)
    assert.throws(() => fs.writeFile('/c', null), TypeError)
    assert.throws(() => fs.writeFile('/c', new Uint16Array([1])), TypeError)
  })

  it('keep a byte order mark', () => {
    const fs = new Vfs()
    const bom = String.fromCodePoint(0xFEFF)
    fs.writeFile('/a', `${bom}x`)
    assert.equal(fs.readText('/a'), `${bom}x`)
    assert.equal(fs.stat('/a').size, 4)
  })

  it('cannot be a directory, or go where no directory is', () => {
    const fs = createVfs({ 'd/f': 'x' })
    fails(() => fs.readFile('/d'), 'EISDIR')
    fails(() => fs.readFile('/'), 'EISDIR')
    fails(() => fs.writeFile('/d', 'x'), 'EISDIR')
    fails(() => fs.writeFile('/d/f/', 'x'), 'ENOTDIR')
    fails(() => fs.writeFile('/e/', 'x'), 'EISDIR')
    fails(() => fs.writeFile('/', 'x'), 'EISDIR')
    fails(() => fs.writeFile('/missing/f', 'x'), 'ENOENT')
    fails(() => fs.writeFile('/d/f/g', 'x'), 'ENOTDIR')
    fails(() => fs.readFile('/missing'), 'ENOENT')
    fails(() => fs.readdir('/d/f'), 'ENOTDIR')
    fails(() => fs.readlink('/d/f'), 'EINVAL')
  })
})

describe('directories', () => {
  it('are made one at a time, or with every missing parent', () => {
    const fs = new Vfs()
    fs.mkdir('/a', { mode: 0o700, mtime: 7 })
    assert.deepEqual(fs.stat('/a'), { type: 'directory', ino: 2, mode: 0o700, mtime: 7, size: 0 })
    fails(() => fs.mkdir('/a'), 'EEXIST')
    fails(() => fs.mkdir('/x/y'), 'ENOENT')
    fs.mkdir('/x/y/z', { recursive: true, mode: 0o711 })
    assert.equal(fs.stat('/x').mode, 0o755, 'a parent made on the way has the default mode')
    assert.equal(fs.stat('/x/y/z').mode, 0o711)
    fs.mkdir('/x/y/z', { recursive: true })
    fs.mkdir('/x/y/z/', { recursive: true })
    fs.writeFile('/f', 'x')
    fails(() => fs.mkdir('/f', { recursive: true }), 'EEXIST')
    fails(() => fs.mkdir('/f/g', { recursive: true }), 'ENOTDIR')
    fs.mkdir('/t/')
    assert.equal(fs.stat('/t').type, 'directory')
    assert.throws(() => fs.mkdir(7), TypeError)
  })

  it('are not made over a link, which mkdir(2) never follows', () => {
    const fs = createVfs({ 'd/f': 'x', todir: { type: 'symlink', target: 'd' }, dangling: { type: 'symlink', target: 'gone' } })
    fails(() => fs.mkdir('/dangling'), 'EEXIST')
    fails(() => fs.mkdir('/dangling', { recursive: true }), 'EEXIST')
    assert.equal(fs.isDirectory('/gone'), false, 'nothing was made where the link leads')
    fails(() => fs.mkdir('/todir'), 'EEXIST')
    fails(() => fs.mkdir('/todir/'), 'EEXIST')
    fs.mkdir('/todir', { recursive: true })
    fs.mkdir('/todir/', { recursive: true })
    fs.mkdir('/todir/new')
    assert.equal(fs.isDirectory('/d/new'), true, 'a link on the way is followed')
  })

  it('list their names in code point order', () => {
    const fs = createVfs({ 'd/b': '', 'd/a': '', 'd/B': '', 'd/sub/x': '' })
    fs.symlink('a', '/d/l')
    assert.deepEqual(fs.readdir('/d'), ['B', 'a', 'b', 'l', 'sub'])
    assert.deepEqual(fs.readdir('/'), ['d'])
    assert.deepEqual(new Vfs().readdir('/'), [])
  })

  it('are removed when empty, and the root never', () => {
    const fs = createVfs({ 'd/f': 'x', e: { type: 'directory' } })
    fails(() => fs.rmdir('/d'), 'ENOTEMPTY')
    fails(() => fs.rmdir('/d/f'), 'ENOTDIR')
    fails(() => fs.rmdir('/'), 'EBUSY')
    fails(() => fs.rmdir('/missing'), 'ENOENT')
    fs.rmdir('/e')
    assert.deepEqual(fs.readdir('/'), ['d'])
    fs.unlink('/d/f')
    fs.rmdir('/d/')
    assert.deepEqual(fs.readdir('/'), [])
  })
})

describe('symbolic links', () => {
  it('hold a target, and are the target to everything but lstat', () => {
    const fs = createVfs({ 'src/app.js': 'code' })
    fs.symlink('src/app.js', '/link', { mtime: 3 })
    assert.equal(fs.readlink('/link'), 'src/app.js')
    assert.equal(fs.readText('/link'), 'code')
    assert.equal(fs.stat('/link').type, 'file')
    assert.deepEqual(fs.lstat('/link'), { type: 'symlink', ino: 4, mode: 0o777, mtime: 3, size: 10 })
    assert.equal(fs.isSymlink('/link'), true)
    assert.equal(fs.isFile('/link'), true)
    assert.equal(fs.isSymlink('/src/app.js'), false)
    fs.symlink('é', '/utf8')
    assert.equal(fs.lstat('/utf8').size, 2, 'as long as the target in bytes')
  })

  it('may lead nowhere', () => {
    const fs = new Vfs()
    fs.symlink('/nowhere', '/dangling')
    assert.equal(fs.lstat('/dangling').type, 'symlink')
    assert.equal(fs.isSymlink('/dangling'), true)
    assert.equal(fs.isFile('/dangling'), false)
    fails(() => fs.stat('/dangling'), 'ENOENT')
    fails(() => fs.readFile('/dangling'), 'ENOENT')
    fs.unlink('/dangling')
    assert.deepEqual(fs.readdir('/'), [])
  })

  it('take a target of any spelling but an empty one', () => {
    const fs = new Vfs()
    fails(() => fs.symlink('', '/a'), 'EINVAL')
    fails(() => fs.symlink('a\0b', '/a'), 'EINVAL')
    fails(() => fs.symlink(1, '/a'), 'EINVAL')
    fs.writeFile('/x', '')
    fs.symlink('../../../x', '/a')
    fs.symlink('/', '/b')
    fs.symlink('.', '/c')
    assert.equal(fs.realpath('/a'), '/x', '.. above the root stays at the root')
    assert.equal(fs.realpath('/b'), '/')
    assert.equal(fs.realpath('/c'), '/')
    fails(() => fs.symlink('x', '/a'), 'EEXIST')
    fails(() => fs.symlink('x', '/d/'), 'ENOENT')
    fails(() => fs.symlink('x', '/missing/d'), 'ENOENT')
  })

  it('are written through: the file the link names is the file written', () => {
    const fs = createVfs({ 'd/f': 'old', 'l': { type: 'symlink', target: 'd/f' } })
    fs.writeFile('/l', 'new')
    assert.equal(fs.readText('/d/f'), 'new')
    assert.equal(fs.lstat('/l').type, 'symlink')
    fs.symlink('d/made', '/m')
    fs.writeFile('/m', 'x')
    assert.equal(fs.readText('/d/made'), 'x', 'a link to nothing is the name made')
    fs.symlink('/gone/f', '/n')
    fails(() => fs.writeFile('/n', 'x'), 'ENOENT')
  })

  it('are unlinked and renamed by name, and never followed to do it', () => {
    const fs = createVfs({ 'd/f': 'x', l: { type: 'symlink', target: 'd' }, m: { type: 'symlink', target: 'd/f' } })
    fs.rename('/m', '/n')
    assert.equal(fs.readlink('/n'), 'd/f')
    fs.unlink('/n')
    assert.equal(fs.readText('/d/f'), 'x')
    fails(() => fs.rmdir('/l'), 'ENOTDIR')
    fails(() => fs.rmdir('/l/'), 'ENOTDIR')
    fails(() => fs.rm('/l/', { recursive: true }), 'ENOTDIR')
    fs.rm('/l', { recursive: true })
    assert.equal(fs.isDirectory('/d'), true)
    assert.deepEqual(fs.readdir('/'), ['d'])
  })
})

describe('resolution', () => {
  it('reads a relative path from the root', () => {
    const fs = createVfs({ 'a/b': 'x' })
    assert.equal(fs.readText('a/b'), 'x')
    assert.equal(fs.readText('./a/./b'), 'x')
    assert.equal(fs.readText('/../a/b'), 'x')
    assert.equal(fs.stat('/..').ino, fs.stat('/').ino)
    assert.equal(fs.realpath('a/../a/./b'), '/a/b')
    fails(() => fs.realpath('a/b/../b'), 'ENOTDIR')
  })

  it('checks every component where it stands, so .. cannot reach a sibling', () => {
    const fs = createVfs({ 'a/file': 'x', 'a/other': 'y' })
    fails(() => fs.readFile('/a/missing/../file'), 'ENOENT')
    fails(() => fs.readFile('/a/file/../other'), 'ENOTDIR')
    fails(() => fs.stat('/a/file/'), 'ENOTDIR')
    fails(() => fs.stat('/a/file/.'), 'ENOTDIR')
    assert.equal(fs.stat('/a/').type, 'directory')
  })

  it('reads a link target from the directory the link is in', () => {
    const fs = createVfs({ 'x': 'root x', 'd/x': 'd x', 'd/up': { type: 'symlink', target: '../x' }, 'd/here': { type: 'symlink', target: 'x' } })
    assert.equal(fs.readText('/d/up'), 'root x')
    assert.equal(fs.readText('/d/here'), 'd x')
    assert.equal(fs.realpath('/d/up'), '/x')
  })

  it('takes an absolute target from the root, and follows a link to a link', () => {
    const fs = createVfs({ 'e/f': 'x', 'd/a': { type: 'symlink', target: '/e/f' }, 'd/b': { type: 'symlink', target: 'a' }, 'd/c': { type: 'symlink', target: 'b' } })
    assert.equal(fs.readText('/d/c'), 'x')
    assert.equal(fs.realpath('/d/c'), '/e/f')
  })

  it('takes .. after a link from where the link leads', () => {
    const fs = createVfs({ 'e/f/g': 'x', 'e/sibling': 's', 'd/l': { type: 'symlink', target: '/e/f' } })
    assert.equal(fs.readText('/d/l/../sibling'), 's')
    assert.equal(fs.realpath('/d/l/..'), '/e')
    assert.equal(fs.realpath('/d/l/'), '/e/f')
    fs.symlink('/e/sibling', '/d/tofile')
    fails(() => fs.stat('/d/tofile/..'), 'ENOTDIR')
    fails(() => fs.stat('/d/tofile/'), 'ENOTDIR')
    assert.equal(fs.lstat('/d/l/').type, 'directory', 'a trailing slash asks lstat for the directory behind the link')
  })

  it('holds a target with a trailing slash to a directory', () => {
    const fs = createVfs({ 'd/f': 'x', 'todir': { type: 'symlink', target: 'd/' }, 'tofile': { type: 'symlink', target: 'd/f/' } })
    assert.equal(fs.stat('/todir').type, 'directory')
    fails(() => fs.stat('/tofile'), 'ENOTDIR')
  })

  it('stops a loop after forty links', () => {
    const fs = new Vfs()
    fs.symlink('self', '/self')
    fails(() => fs.stat('/self'), 'ELOOP', '/self')
    fs.symlink('b', '/a')
    fs.symlink('a', '/b')
    fails(() => fs.readFile('/a'), 'ELOOP')
    fails(() => fs.stat('/a/'), 'ELOOP')
    assert.equal(fs.lstat('/a').type, 'symlink')
    fs.writeFile('/end', 'x')
    let target = 'end'
    for (let i = 0; i < 41; i++) { fs.symlink(target, `/l${i}`); target = `l${i}` }
    assert.equal(fs.readText('/l39'), 'x', 'forty links deep resolves')
    fails(() => fs.readText('/l40'), 'ELOOP')
  })

  it('refuses a path that is not one', () => {
    const fs = new Vfs()
    fails(() => fs.stat(''), 'ENOENT', '')
    fails(() => fs.stat('a\0b'), 'EINVAL')
    assert.throws(() => fs.stat(null), TypeError)
    assert.throws(() => fs.lstat(null), TypeError)
    assert.throws(() => fs.isFile(undefined), TypeError, 'a wrong type is not a missing file')
    assert.equal(fs.isFile('/nope'), false)
    assert.equal(fs.isDirectory('/nope'), false)
    assert.equal(fs.isDirectory('/'), true)
  })

  it('realpath spells the canonical name of what is there', () => {
    const fs = createVfs({ 'a/b/c': 'x', 'l': { type: 'symlink', target: 'a/b' } })
    assert.equal(fs.realpath('/'), '/')
    assert.equal(fs.realpath('l/./c'), '/a/b/c')
    assert.equal(fs.realpath('l'), '/a/b')
    assert.equal(fs.realpath('/a/b/../b'), '/a/b')
    fails(() => fs.realpath('/a/b/c/..'), 'ENOTDIR')
    fails(() => fs.realpath('/l/missing'), 'ENOENT')
    fails(() => fs.realpath('/missing'), 'ENOENT')
  })
})

describe('hard links', () => {
  it('are one inode under two names', () => {
    const fs = createVfs({ 'a': 'x' })
    fs.link('/a', '/b')
    assert.equal(fs.stat('/a').ino, fs.stat('/b').ino)
    fs.writeFile('/b', 'changed')
    assert.equal(fs.readText('/a'), 'changed')
    fs.unlink('/a')
    assert.equal(fs.readText('/b'), 'changed')
    fails(() => fs.link('/b', '/b'), 'EEXIST')
    fails(() => fs.link('/missing', '/c'), 'ENOENT')
    fails(() => fs.link('/', '/c'), 'EPERM')
    fails(() => fs.link('/b', '/c/'), 'ENOENT')
  })

  it('link a symlink itself, not what it names', () => {
    const fs = createVfs({ 'a': 'x', 'l': { type: 'symlink', target: 'a' } })
    fs.link('/l', '/m')
    assert.equal(fs.lstat('/m').type, 'symlink')
    assert.equal(fs.lstat('/m').ino, fs.lstat('/l').ino)
  })
})

describe('removal', () => {
  it('unlink takes a name that is not a directory', () => {
    const fs = createVfs({ 'd/f': 'x' })
    fails(() => fs.unlink('/d'), 'EISDIR')
    fails(() => fs.unlink('/missing'), 'ENOENT')
    fails(() => fs.unlink('/d/f/'), 'ENOTDIR')
    fs.unlink('/d/f')
    assert.deepEqual(fs.readdir('/d'), [])
  })

  it('rm takes a directory only recursively, and never the root', () => {
    const fs = createVfs({ 'd/a/b/c': 'x', 'd/f': 'y', 'e': 'z' })
    fails(() => fs.rm('/d'), 'EISDIR')
    fails(() => fs.rm('/', { recursive: true }), 'EBUSY')
    fails(() => fs.rm('/missing'), 'ENOENT')
    fs.rm('/e')
    fs.rm('/d', { recursive: true })
    assert.deepEqual(fs.readdir('/'), [])
  })
})

describe('rename', () => {
  it('moves a name, replacing a file or an empty directory', () => {
    const fs = createVfs({ 'a': 'x', 'b': 'y', 'd/f': 'z', 'e': { type: 'directory' } })
    fs.rename('/a', '/moved')
    assert.deepEqual(fs.readdir('/'), ['b', 'd', 'e', 'moved'])
    fs.rename('/moved', '/b')
    assert.equal(fs.readText('/b'), 'x')
    fs.rename('/d', '/e')
    assert.equal(fs.readText('/e/f'), 'z')
    assert.deepEqual(fs.readdir('/'), ['b', 'e'])
    fs.rename('/e', '/d/')
    assert.equal(fs.readText('/d/f'), 'z')
  })

  it('refuses what rename(2) refuses', () => {
    const fs = createVfs({ 'f': 'x', 'd/a': 'y', 'e': { type: 'directory' }, 'g': 'z' })
    fails(() => fs.rename('/missing', '/x'), 'ENOENT')
    fails(() => fs.rename('/', '/x'), 'EBUSY')
    fails(() => fs.rename('/f', '/'), 'EINVAL')
    fails(() => fs.rename('/f', '/d'), 'EISDIR')
    fails(() => fs.rename('/d', '/f'), 'ENOTDIR')
    fails(() => fs.rename('/f', '/g/'), 'ENOTDIR')
    fails(() => fs.rename('/e', '/d'), 'ENOTEMPTY')
    fails(() => fs.rename('/d', '/d/a/inside'), 'ENOTDIR')
    fails(() => fs.rename('/d', '/d/inside'), 'EINVAL')
    fails(() => fs.rename('/f', '/missing/x'), 'ENOENT')
    assert.equal(fs.readText('/f'), 'x')
    assert.equal(fs.readText('/d/a'), 'y')
  })

  it('leaves two names of one inode as they are', () => {
    const fs = createVfs({ 'a': 'x' })
    fs.link('/a', '/b')
    fs.rename('/a', '/b')
    assert.deepEqual(fs.readdir('/'), ['a', 'b'])
  })
})

describe('walk', () => {
  it('goes depth first, siblings in code point order, and names a link without crossing it', () => {
    const fs = createVfs({ 'b/y': '', 'b/x/deep': '', 'a': '', 'B': '', 'l': { type: 'symlink', target: 'b' } })
    assert.deepEqual([...fs.walk()], [
      { path: '/', type: 'directory', depth: 0 },
      { path: '/B', type: 'file', depth: 1 },
      { path: '/a', type: 'file', depth: 1 },
      { path: '/b', type: 'directory', depth: 1 },
      { path: '/b/x', type: 'directory', depth: 2 },
      { path: '/b/x/deep', type: 'file', depth: 3 },
      { path: '/b/y', type: 'file', depth: 2 },
      { path: '/l', type: 'symlink', depth: 1 },
    ])
    assert.deepEqual([...fs.walk('/b/x')], [{ path: '/b/x', type: 'directory', depth: 0 }, { path: '/b/x/deep', type: 'file', depth: 1 }])
    assert.deepEqual([...fs.walk('/a')], [{ path: '/a', type: 'file', depth: 0 }])
    assert.deepEqual([...fs.walk('l')], [...fs.walk('/b')], 'a link named as the start is what it leads to')
    fails(() => [...fs.walk('/missing')], 'ENOENT')
  })

  it('and a recursive removal survive a tree deeper than any stack', () => {
    const fs = new Vfs()
    const deep = 'd/'.repeat(20000)
    fs.mkdir(deep, { recursive: true })
    fs.writeFile(`${deep}leaf`, 'x')
    let count = 0
    for (const entry of fs.walk()) count += entry.type === 'directory' ? 1 : 0
    assert.equal(count, 20001)
    assert.equal(fs.realpath(`${deep}leaf`), `/${deep}leaf`)
    fs.rm('/d', { recursive: true })
    assert.deepEqual(fs.readdir('/'), [])
  })
})

describe('names', () => {
  it('may be anything a Map holds, including what an object would take for its own', () => {
    const fs = createVfs(new Map([['__proto__', 'p'], ['constructor/toString', 't'], ['hasOwnProperty', 'h']]))
    assert.equal(fs.readText('/__proto__'), 'p')
    assert.equal(fs.readText('/constructor/toString'), 't')
    assert.deepEqual(fs.readdir('/'), ['__proto__', 'constructor', 'hasOwnProperty'])
    assert.equal(fs.isFile('/valueOf'), false)
    assert.equal(Object.getPrototypeOf(fs.readFile('/hasOwnProperty')), Uint8Array.prototype)
  })

  it('are text with an encoding, of at most 255 bytes of it', () => {
    const fs = new Vfs()
    const lone = String.fromCodePoint(0xD800)
    const long = 'a'.repeat(256)
    const wide = String.fromCodePoint(0x1F600).repeat(64)
    fs.writeFile('/f', '')
    fails(() => fs.writeFile(`/${lone}`, ''), 'EILSEQ', `/${lone}`)
    fails(() => fs.appendFile(`/${lone}`, ''), 'EILSEQ')
    fails(() => fs.mkdir(`/${lone}`), 'EILSEQ')
    fails(() => fs.mkdir(`/${lone}/d`, { recursive: true }), 'EILSEQ', `/${lone}/d`)
    fails(() => fs.symlink('x', `/${lone}`), 'EILSEQ')
    fails(() => fs.symlink(lone, '/s'), 'EILSEQ', '/s')
    fails(() => fs.link('/f', `/${lone}`), 'EILSEQ')
    fails(() => fs.rename('/f', `/${lone}`), 'EILSEQ', `/${lone}`)
    fails(() => fs.writeFile(`/${long}`, ''), 'ENAMETOOLONG', `/${long}`)
    fails(() => fs.mkdir(`/d/${long}`, { recursive: true }), 'ENAMETOOLONG')
    fails(() => fs.rename('/f', `/${wide}`), 'ENAMETOOLONG')
    fails(() => fs.link('/f', `/${wide}`), 'ENAMETOOLONG')
    assert.equal(fs.isDirectory('/d'), true, 'mkdir -p makes the parents before the name it refuses, as it does on disk')
    assert.equal(fs.isFile('/f'), true, 'a refused rename moves nothing')
    fails(() => fs.stat(`/${lone}`), 'ENOENT', `/${lone}`)
    fails(() => fs.stat(`/${long}`), 'ENOENT')
    fs.writeFile(`/${long.slice(1)}`, '')
    fs.mkdir(`/${wide.slice(2)}`)
    assert.deepEqual(fs.readdir('/'), ['a'.repeat(255), 'd', 'f', String.fromCodePoint(0x1F600).repeat(63)])
  })
})

describe('errors', () => {
  it('carry the code and the path, and read as a shell would print them', () => {
    const fs = new Vfs()
    try {
      fs.readFile('/nope')
      assert.fail('should have thrown')
    } catch (error) {
      assert.ok(error instanceof VfsError)
      assert.equal(error.name, 'VfsError')
      assert.equal(error.code, 'ENOENT')
      assert.equal(error.path, '/nope')
      assert.equal(error.message, '/nope: No such file or directory')
    }
  })
})
