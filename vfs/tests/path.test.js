import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { basename, compareNames, dirname, join, normalize } from '../index.js'

describe('normalize folds a spelling by itself', () => {
  it('collapses . and .., and .. at the root stays there', () => {
    assert.equal(normalize('/a/./b/../c'), '/a/c')
    assert.equal(normalize('/../a'), '/a')
    assert.equal(normalize('/'), '/')
    assert.equal(normalize('//a//b/'), '/a/b')
    assert.equal(normalize('a/../../b'), '../b')
    assert.equal(normalize('a/..'), '.')
    assert.equal(normalize(''), '.')
    assert.equal(normalize('.'), '.')
    assert.equal(normalize('a/b/'), 'a/b')
  })
})

describe('join puts a path under a base without folding it', () => {
  it('keeps an absolute path and joins a relative one', () => {
    assert.equal(join('/', 'a/b'), '/a/b')
    assert.equal(join('/x', 'a/b'), '/x/a/b')
    assert.equal(join('/x/', 'a'), '/x/a')
    assert.equal(join('/x', '/a'), '/a')
    assert.equal(join('/x', '../a'), '/x/../a')
  })
})

describe('dirname and basename', () => {
  it('read the last name off a normalized spelling', () => {
    assert.equal(dirname('/a/b/c'), '/a/b')
    assert.equal(dirname('/a'), '/')
    assert.equal(dirname('/'), '/')
    assert.equal(dirname('a'), '.')
    assert.equal(dirname('a/b/'), 'a')
    assert.equal(basename('/a/b/c'), 'c')
    assert.equal(basename('/a/b/'), 'b')
    assert.equal(basename('/'), '/')
    assert.equal(basename('a'), 'a')
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
