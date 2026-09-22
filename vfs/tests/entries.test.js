import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pack, unpack } from '@preventive/tar'
import { Vfs, createVfs, vfsFromEntries } from '../vfs.js'

const bytes = (text) => new TextEncoder().encode(text)

describe('createVfs reads a flat map of paths', () => {
  it('as files, with their parents implied, from an object or a Map', () => {
    for (const sources of [{ 'a/b/c.txt': 'text', '/d.bin': new Uint8Array([0, 1]), './e': 'e' }, new Map([['a/b/c.txt', 'text'], ['/d.bin', new Uint8Array([0, 1])], ['./e', 'e']])]) {
      const fs = createVfs(sources)
      assert.deepEqual([...fs.walk()].map((entry) => entry.path), ['/', '/a', '/a/b', '/a/b/c.txt', '/d.bin', '/e'])
      assert.equal(fs.readText('/a/b/c.txt'), 'text')
      assert.deepEqual(fs.readFile('/d.bin'), new Uint8Array([0, 1]))
      assert.equal(fs.stat('/a').mode, 0o755)
      assert.equal(fs.stat('/a/b/c.txt').mode, 0o644)
    }
    assert.deepEqual(createVfs().readdir('/'), [])
  })

  it('and the entries a string cannot say', () => {
    const fs = createVfs({
      'dir': { type: 'directory', mode: 0o700, mtime: 1 },
      'file': { type: 'file', data: bytes('f'), mode: 0o600, mtime: 2 },
      'empty': { type: 'file' },
      'link': { type: 'symlink', target: 'file', mtime: 3 },
      'hard': { type: 'link', target: 'file' },
      '': { type: 'directory', mode: 0o711, mtime: 4 },
    })
    assert.deepEqual(fs.stat('/dir'), { type: 'directory', ino: fs.stat('/dir').ino, mode: 0o700, mtime: 1, size: 0 })
    assert.deepEqual(fs.stat('/file'), { type: 'file', ino: fs.stat('/file').ino, mode: 0o600, mtime: 2, size: 1 })
    assert.equal(fs.stat('/empty').size, 0)
    assert.equal(fs.readlink('/link'), 'file')
    assert.equal(fs.lstat('/link').mtime, 3)
    assert.equal(fs.stat('/hard').ino, fs.stat('/file').ino)
    assert.deepEqual(fs.stat('/'), { type: 'directory', ino: 1, mode: 0o711, mtime: 4, size: 0 })
  })

  it('refuses a tree that contradicts itself, and a value that says nothing', () => {
    assert.throws(() => createVfs({ 'a': 'file', 'a/b': 'under a file' }), { code: 'EEXIST' }, 'what mkdir -p says of a file in its way')
    assert.throws(() => createVfs({ 'a': 'file', 'a/b/c': 'under a file' }), { code: 'ENOTDIR' })
    assert.throws(() => createVfs({ 'a/b': 'x', 'a': 'now a file' }), { code: 'EISDIR' })
    assert.throws(() => createVfs({ 'a': 'x', 'b': { type: 'link', target: 'missing' } }), { code: 'ENOENT' })
    assert.throws(() => createVfs({ 'a': { type: 'fifo' } }), { code: 'EINVAL', path: 'a' })
    assert.throws(() => createVfs({ 'a': 42 }), TypeError)
    assert.throws(() => createVfs({ 'a': null }), TypeError)
    assert.throws(() => createVfs({ 'a': {} }), TypeError)
    assert.throws(() => createVfs({ 'a': ['x'] }), TypeError)
    assert.throws(() => createVfs(null), TypeError)
    assert.throws(() => createVfs('a'), TypeError)
    assert.throws(() => createVfs([{ name: 'a', data: 'x' }]), TypeError, 'entries go to vfsFromEntries')
  })
})

describe('entries are the tree as tar would carry it', () => {
  const tree = () => {
    const fs = createVfs({
      'README.md': 'hello\n',
      'bin/tool': { type: 'file', data: bytes('#!/bin/sh\n'), mode: 0o755, mtime: 100 },
      'lib/data.bin': new Uint8Array([0, 255, 1]),
      'lib/link': { type: 'symlink', target: '../README.md', mtime: 50 },
      'empty': { type: 'directory', mode: 0o700 },
    })
    fs.link('/README.md', '/lib/readme-again')
    return fs
  }

  it('names each inode once, a second name of a file as a hard link', () => {
    assert.deepEqual([...tree().entries()], [
      { name: '.', type: 'directory', mode: 0o755, mtime: 0, linkname: '', data: new Uint8Array() },
      { name: 'README.md', type: 'file', mode: 0o644, mtime: 0, linkname: '', data: bytes('hello\n') },
      { name: 'bin', type: 'directory', mode: 0o755, mtime: 0, linkname: '', data: new Uint8Array() },
      { name: 'bin/tool', type: 'file', mode: 0o755, mtime: 100, linkname: '', data: bytes('#!/bin/sh\n') },
      { name: 'empty', type: 'directory', mode: 0o700, mtime: 0, linkname: '', data: new Uint8Array() },
      { name: 'lib', type: 'directory', mode: 0o755, mtime: 0, linkname: '', data: new Uint8Array() },
      { name: 'lib/data.bin', type: 'file', mode: 0o644, mtime: 0, linkname: '', data: new Uint8Array([0, 255, 1]) },
      { name: 'lib/link', type: 'symlink', mode: 0o777, mtime: 50, linkname: '../README.md', data: new Uint8Array() },
      { name: 'lib/readme-again', type: 'link', mode: 0o644, mtime: 0, linkname: 'README.md', data: new Uint8Array() },
    ])
  })

  it('start where they are asked to', () => {
    const fs = tree()
    assert.deepEqual([...fs.entries('/lib')].map((entry) => entry.name), ['.', 'data.bin', 'link', 'readme-again'])
    assert.equal([...fs.entries('/lib')][3].type, 'file', 'the first name seen of a hard-linked file is the file')
    assert.deepEqual([...fs.entries('bin/tool')].map((entry) => entry.name), ['tool'])
    assert.throws(() => [...fs.entries('/missing')], { code: 'ENOENT' })
  })

  it('build the same tree back, as tar entries do', () => {
    const fs = tree()
    const original = [...fs.entries()]
    assert.deepEqual([...vfsFromEntries(original).entries()], original)
    const archived = unpack(pack(fs.entries()))
    assert.deepEqual([...vfsFromEntries(archived).entries()], original)
  })

  it('take entries out of order, a directory listed again, and a file of a second spelling', () => {
    const fs = vfsFromEntries([
      { name: 'a/b/c', data: 'deep' },
      { name: 'a', type: 'directory', mode: 0o700, mtime: 9 },
      { name: './a/b/d', type: 'contiguous-file', data: bytes('cf'), mode: 0o600 },
      { name: '.', type: 'directory', mode: 0o711 },
      { name: 'a/b/e', type: 'link', linkname: 'a/b/c' },
    ])
    assert.equal(fs.readText('/a/b/c'), 'deep')
    assert.equal(fs.readText('/a/b/e'), 'deep')
    assert.deepEqual(fs.stat('/a'), { type: 'directory', ino: fs.stat('/a').ino, mode: 0o700, mtime: 9, size: 0 })
    assert.equal(fs.stat('/a/b/d').mode, 0o600)
    assert.equal(fs.stat('/').mode, 0o711)
    assert.throws(() => vfsFromEntries([{ name: 'x', type: 'fifo' }]), { code: 'EINVAL', path: 'x' })
    assert.throws(() => vfsFromEntries([{ name: 5 }]), TypeError)
    assert.throws(() => vfsFromEntries([{ name: 'a', type: 'directory' }, { name: 'a', data: 'x' }]), { code: 'EISDIR' })
  })

  it('cannot escape the root', () => {
    const fs = vfsFromEntries([{ name: '../../etc/passwd', data: 'x' }])
    assert.deepEqual([...fs.walk()].map((entry) => entry.path), ['/', '/etc', '/etc/passwd'])
    assert.equal(new Vfs().isFile('../x'), false)
  })
})
