import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffFormat, diffLineStyles } from '../src/color.js'

// Reading diff output back far enough to paint it: which style it is written
// in, and what part each line plays. No colour is applied here and none is
// applied there — a caller holds the terminal — so what is under test is the
// recognition alone.

const UNIFIED = '--- a.txt\n+++ b.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n'
const NORMAL = '2c2\n< two\n---\n> 2\n3a4\n> four\n'
const CONTEXT = '*** a.txt\n--- b.txt\n***************\n*** 1,3 ****\n  one\n! two\n--- 1,4 ----\n+ four\n'

// The array runs parallel to the lines, so a case reads as the text does.
const styled = (text) => {
  const styles = diffLineStyles(text)
  return styles && text.split('\n').map((line, i) => [line, styles[i]])
}

describe('a diff is recognised by its own markers', () => {
  it('tells the three styles apart', () => {
    assert.equal(diffFormat(UNIFIED), 'unified')
    assert.equal(diffFormat(NORMAL), 'normal')
    // A context diff carries `---` headers of its own, so the fence has to
    // be looked for before anything else.
    assert.equal(diffFormat(CONTEXT), 'context')
  })

  it('gives a unified diff a style per role', () => {
    // The file headers are bold rather than red and green, so a `---` header
    // is not taken for a removed line.
    assert.deepEqual(styled(UNIFIED), [
      ['--- a.txt', 'bold'], ['+++ b.txt', 'bold'], ['@@ -1,3 +1,4 @@', 'cyan'],
      [' one', null], ['-two', 'red'], ['+2', 'green'], [' three', null], ['+four', 'green'], ['', null],
    ])
  })

  it('gives a normal diff one, separator included', () => {
    assert.deepEqual(styled(NORMAL), [
      ['2c2', 'cyan'], ['< two', 'red'], ['---', 'gray'], ['> 2', 'green'], ['3a4', 'cyan'], ['> four', 'green'], ['', null],
    ])
  })

  it('gives a context diff one, changed lines apart from added ones', () => {
    assert.deepEqual(styled(CONTEXT), [
      ['*** a.txt', 'bold'], ['--- b.txt', 'bold'], ['***************', 'cyan'], ['*** 1,3 ****', 'cyan'],
      ['  one', null], ['! two', 'yellow'], ['--- 1,4 ----', 'cyan'], ['+ four', 'green'], ['', null],
    ])
  })

  it('marks a missing newline apart from the line it follows', () => {
    assert.deepEqual(styled('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n').at(-2), ['+a', 'green'])
    assert.deepEqual(styled('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n')[2], ['\\ No newline at end of file', 'gray'])
  })
})

describe('what is not a diff is left alone', () => {
  // `+`, `-` and `---` are ordinary in prose and in code. Without a hunk
  // header, a fence or a change command, none of it is a diff.
  for (const [label, text] of [
    ['a markdown list', 'plain text\n+ a bullet\n- another\n--- a rule\n'],
    ['a source file', 'const a = 1\n-- comment\n+++ nope\n'],
    ['command output', 'a.txt\nsub/b.js\n'],
    ['an empty string', ''],
    ['a lone dash rule', '---\n'],
  ]) {
    it(label, () => {
      assert.equal(diffFormat(text), null)
      // Null rather than an array of nulls, so a caller can hand the text
      // straight back without walking it.
      assert.equal(diffLineStyles(text), null)
    })
  }

  it('styles only the diff lines when other output surrounds them', () => {
    const mixed = `listing\n${UNIFIED}done\n`
    const styles = diffLineStyles(mixed)
    assert.equal(diffFormat(mixed), 'unified')
    assert.equal(styles[0], null, 'the line before the diff takes no style')
    assert.equal(styles.at(-2), null, 'the line after it takes none either')
    assert.deepEqual(styles.slice(1, 4), ['bold', 'bold', 'cyan'])
  })
})
