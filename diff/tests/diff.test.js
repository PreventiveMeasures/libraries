import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diff } from '../src/diff.js'
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

describe('two files the comparison calls the same', () => {
  it('are no diff at all, not an empty one under a header', () => {
    assert.equal(diff('a\nb\n', 'a\nb\n'), '')
    assert.equal(diff('', ''), '')
    assert.equal(diff('a  b\n', 'a b\n', { whitespace: 'all' }), '')
  })
})
