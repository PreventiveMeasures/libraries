import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyChangeSet } from '../src/apply.js'
import { diff } from '../src/diff.js'
import { parseDiff } from '../src/parse.js'
import { FILES, RECORDINGS } from './fixtures/gnu-diff.js'

// The one call, held to the same recordings the pieces are: whatever the
// parts produce in the order they are meant to be used, this produces in
// one step, byte for byte.

describe('one call produces what the parts produce', () => {
  for (const recording of RECORDINGS) {
    // The -p cases need a name for each hunk, which is the caller's to
    // choose; that `label` reaches the formatter is checked on its own below.
    if (recording.showFunction) continue
    it(recording.command, () => {
      const header = recording.format === 'normal' ? '' : recording.stdout.split('\n').slice(0, 2).join('\n') + '\n'
      const [from, to] = recording.names.map((name) => FILES[name])
      assert.equal(header + diff(from, to, { format: recording.format, context: recording.context }), recording.stdout)
    })
  }
})

describe('what it does with the options', () => {
  it('defaults to unified with three lines of context', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\nh\n', b = 'a\nb\nc\nX\ne\nf\ng\nh\n'
    assert.equal(diff(a, b), '@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+X\n e\n f\n g\n')
  })
  it('writes no label lines, which are the caller\'s to put in front', () => {
    // Keeping them out is what lets everything returned here be read back:
    // a label that read like diff content would not be, and nothing in the
    // package could have told the caller so.
    assert.equal(diff('x\n', 'y\n'), '@@ -1 +1 @@\n-x\n+y\n')
  })
  it('passes label through to name a hunk', () => {
    assert.match(diff('a\nb\n', 'a\nX\n', { label: () => 'in here' }), /^@@ -1,2 \+1,2 @@ in here\n/u)
  })
  it('carries the comparison options to the search', () => {
    assert.equal(diff('A  b\n', 'a b\n', { ignoreCase: true, whitespace: 'all' }), '')
    assert.notEqual(diff('A  b\n', 'a b\n'), '')
  })
  it('renders the other two formats', () => {
    assert.equal(diff('a\n', 'b\n', { format: 'normal' }), '1c1\n< a\n---\n> b\n')
    assert.equal(diff('a\n', 'b\n', { format: 'context' }), '***************\n*** 1 ****\n! a\n--- 1 ----\n! b\n')
  })
})

// diff settles a run that could sit in more than one place only where it
// prints context lines for it to sit among, so its normal output and its -u
// output describe different change sets — and -U0, printing no context,
// agrees with normal rather than with -u. These are the strings GNU diff
// 3.10 prints for one pair where a run is free: two trailing blank lines,
// one of which goes.
describe('a free run is settled where diff settles it, and not otherwise', () => {
  const a = '\na\n\n\n', b = 'a\n\n'
  for (const [name, options, expected] of [
    ['normal prints no context, so it takes the search\'s placement', { format: 'normal' }, '1d0\n< \n3d1\n< \n'],
    ['-U0 prints none either, and agrees with normal', { context: 0 }, '@@ -1 +0,0 @@\n-\n@@ -3 +1,0 @@\n-\n'],
    ['-C0 likewise', { format: 'context', context: 0 }, '***************\n*** 1 ****\n- \n--- 0 ----\n***************\n*** 3 ****\n- \n--- 1 ----\n'],
    ['-U1 prints one, and settles', { context: 1 }, '@@ -1,4 +1,2 @@\n-\n a\n \n-\n'],
    ['-u settles', {}, '@@ -1,4 +1,2 @@\n-\n a\n \n-\n'],
    ['-c settles', { format: 'context' }, '***************\n*** 1,4 ****\n- \n  a\n  \n- \n--- 1,2 ----\n'],
  ]) {
    it(name, () => assert.equal(diff(a, b, options), expected))
  }
  it('takes an explicit slide over the default, either way', () => {
    assert.equal(diff(a, b, { format: 'normal', slide: true }), '1d0\n< \n4d2\n< \n')
    assert.equal(diff(a, b, { slide: false }), '@@ -1,4 +1,2 @@\n-\n a\n-\n \n')
  })
})

describe('brief answers whether they differ, and stops there', () => {
  it('says nothing when they are the same', () => {
    assert.equal(diff('a\nb\n', 'a\nb\n', { format: 'brief' }), '')
    assert.equal(diff('', '', { format: 'brief' }), '')
  })
  it('says so when they are not', () => {
    assert.equal(diff('a\nb\n', 'a\nX\n', { format: 'brief' }), 'Files differ\n')
    assert.equal(diff('', 'a\n', { format: 'brief' }), 'Files differ\n')
  })
  it('names no files, having never been told any', () => {
    // Which two they were is the caller's to say, as the label lines are.
    assert.equal(diff('a\n', 'b\n', { format: 'brief' }), 'Files differ\n')
  })
  it('answers under the comparison, not under the bytes', () => {
    assert.equal(diff('A  b\n', 'a b\n', { format: 'brief', ignoreCase: true, whitespace: 'all' }), '')
    assert.equal(diff('A  b\n', 'a c\n', { format: 'brief', ignoreCase: true, whitespace: 'all' }), 'Files differ\n')
    // And a trailing-newline difference is a difference, as it is to a diff.
    assert.equal(diff('a\n', 'a', { format: 'brief' }), 'Files differ\n')
  })
  it('agrees with what the other formats print', () => {
    for (const [a, b] of [['x\n', 'x\n'], ['x\n', 'y\n'], ['', 'a\n'], ['a\nb\n', 'a\n'], ['x\n', 'x']]) {
      const differs = diff(a, b, { format: 'brief' }) !== ''
      assert.equal(differs, diff(a, b) !== '', JSON.stringify([a, b]))
      assert.equal(differs, diff(a, b, { format: 'normal' }) !== '', JSON.stringify([a, b]))
    }
  })
})

describe('two files the comparison calls the same', () => {
  it('are no diff at all, not an empty one under a header', () => {
    assert.equal(diff('a\nb\n', 'a\nb\n'), '')
    assert.equal(diff('', ''), '')
    assert.equal(diff('a  b\n', 'a b\n', { whitespace: 'all' }), '')
  })
})

// The three public calls are one circle: what diff says of two files, read
// back and carried out over the first, is the second.
describe('a diff describes what it takes to get from one file to the other', () => {
  for (const [name, a, b] of [
    ['a change, a deletion and an insertion', 'one\ntwo\nthree\nfour\n', 'one\nTWO\nfour\nfive\n'],
    ['a file that starts empty', '', 'added\n'],
    ['a file that ends empty', 'gone\n', ''],
    ['a last line that loses its terminator', 'x\n', 'x'],
    ['a last line that gains one', 'x', 'x\n'],
    ['blank lines around the change', 'a\n\n\nb\n', 'a\n\nc\n\nb\n'],
  ]) {
    for (const format of ['unified', 'context', 'normal']) {
      it(`${name}, in ${format}`, () => {
        const text = diff(a, b, { format })
        assert.equal(applyChangeSet(a, parseDiff(text)[0].blocks), b)
      })
    }
  }
})
