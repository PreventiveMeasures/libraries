import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { describe, it } from 'node:test'
import { basename, compareNames, dirname, extname, isAbsolute, join, normalize, relative, resolve, segments, sep } from '../path.js'

// The reference is node's own posix flavour, on a corpus of every spelling
// shape that matters: empty, dots, runs of slashes, trailing slashes, `..`
// above the root, and names made of dots. `resolve` and `relative` are
// compared from `/`, which node reads as its working directory here.
const SPELLINGS = ['', '.', '..', '/', '//', '///', 'a', '/a', 'a/', '/a/', 'a//', 'a/b', 'a//b', '/a//b', '//a', '//a/b', './a', 'a/./b', 'a/../b', '../a', '/../a', 'a/../..', 'a/b/../../..', '/a/b/../..', 'a/b/', './', '../', 'a/../', '/a/../', '.a', 'a.', '..a', 'a..', '...', '.a.', 'a.b.c', 'a/b.c/d', '/a/b.c/', 'dir/.hidden', 'a.b/', '/.', '/..', 'x/..//', 'a/b//..//c/', 'b/a', 'x/.js', '.js']

describe('answers as node:path.posix does', () => {
  for (const name of ['normalize', 'dirname', 'basename', 'extname', 'isAbsolute']) {
    const ours = { normalize, dirname, basename, extname, isAbsolute }[name]
    it(name, () => {
      for (const path of SPELLINGS) assert.equal(ours(path), posix[name](path), JSON.stringify(path))
    })
  }

  it('basename with a suffix, on a path without a trailing slash', () => {
    for (const path of SPELLINGS.filter((spelling) => !spelling.endsWith('/'))) {
      for (const suffix of ['.c', 'a', '.js', 'b/a']) assert.equal(basename(path, suffix), posix.basename(path, suffix), JSON.stringify([path, suffix]))
    }
  })

  it('join, resolve and relative, over every pair', () => {
    for (const a of SPELLINGS) {
      assert.equal(resolve(a), posix.resolve('/', a), JSON.stringify(a))
      for (const b of SPELLINGS) {
        const pair = JSON.stringify([a, b])
        assert.equal(join(a, b), posix.join(a, b), pair)
        assert.equal(resolve(a, b), posix.resolve('/', a, b), pair)
        assert.equal(relative(a, b), posix.relative(posix.resolve('/', a), posix.resolve('/', b)), pair)
      }
    }
    assert.equal(join(), '.')
    assert.equal(resolve(), '/')
    assert.equal(join('a', '', 'b/', '', 'c'), 'a/b/c')
  })

  it('and answers the name where node slips on a suffix', () => {
    assert.equal(basename('/', 'a'), '')
    assert.equal(basename('///', '.c'), '')
    assert.equal(basename('a/c/', '.c'), 'c')
    assert.equal(basename('a/b//..//c/', '.c'), 'c')
    assert.equal(basename('x.js/', '.js'), 'x')
  })
})

describe('the shapes worth reading off', () => {
  it('normalize keeps a trailing slash and .. above the root stays there', () => {
    assert.equal(normalize('/a/./b/../c/'), '/a/c/')
    assert.equal(normalize('/../a'), '/a')
    assert.equal(normalize('a/../../b'), '../b')
    assert.equal(normalize(''), '.')
    assert.equal(normalize('a/../'), './')
  })

  it('resolve is absolute, from /, without a trailing slash', () => {
    assert.equal(resolve('a', 'b/'), '/a/b')
    assert.equal(resolve('/x', 'y', '/z', 'w'), '/z/w')
    assert.equal(resolve('/a/b', '../c'), '/a/c')
  })

  it('relative walks up and back down', () => {
    assert.equal(relative('/a/b/c', '/a/d'), '../../d')
    assert.equal(relative('/a', '/a'), '')
    assert.equal(relative('/', '/a/b'), 'a/b')
    assert.equal(relative('/a/b', '/'), '../..')
  })

  it('dirname, basename and extname take a name off the end', () => {
    assert.equal(dirname('/a/b/c/'), '/a/b')
    assert.equal(dirname('/'), '/')
    assert.equal(basename('/a/b.tar.gz', '.gz'), 'b.tar')
    assert.equal(basename('/'), '')
    assert.equal(extname('a.tar.gz'), '.gz')
    assert.equal(extname('.bashrc'), '')
    assert.equal(extname('a.'), '.')
    assert.equal(extname('a/b.c/d'), '')
  })

  it('segments are the non-empty components, dots included', () => {
    assert.deepEqual(segments('//a/./b/../c/'), ['a', '.', 'b', '..', 'c'])
    assert.deepEqual(segments('/'), [])
    assert.deepEqual(segments(''), [])
    assert.equal(sep, '/')
  })

  it('refuses anything but a string', () => {
    for (const fn of [normalize, dirname, basename, extname, isAbsolute, segments, resolve, relative]) assert.throws(() => fn(42), TypeError)
    assert.throws(() => join('a', null), TypeError)
    assert.throws(() => basename('a', 1), TypeError)
    assert.throws(() => relative('/a', undefined), TypeError)
  })
})

describe('compareNames orders by code point', () => {
  it('puts an astral character after every BMP one, unlike the default sort', () => {
    const astral = String.fromCodePoint(0x1F600)
    const bmp = String.fromCodePoint(0xFFFD)
    assert.ok(compareNames(bmp, astral) < 0)
    assert.ok([astral, bmp].sort()[0] === astral, 'the default sort compares UTF-16 units')
    assert.deepEqual(['b', 'a', 'ab', 'B', ''].sort(compareNames), ['', 'B', 'a', 'ab', 'b'])
    assert.equal(compareNames('same', 'same'), 0)
  })
})
