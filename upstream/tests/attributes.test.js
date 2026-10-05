import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'node:test'

import { attributesOf, withAttributes, writtenWithCrlf } from '../src/attributes.js'

// The .gitattributes at `base` of `text`, below those `above`.
const below = (above, base, text) => withAttributes(above, base, Buffer.from(text, 'latin1'))
const root = (text) => below([], '', text)
const states = (files, path) => Object.fromEntries(attributesOf(files, path))

// Every expectation below is what `git check-attr --source` (git 2.43)
// answers, reading the .gitattributes from a tree as `git archive` does.
describe('attributesOf', () => {
  it('matches a pattern to a path as git does', () => {
    for (const [pattern, path, expected] of [
      ['*.bat', 'f.bat', true], ['*.bat', 'deep/dir/f.bat', true], ['*.bat', 'f.bat.bak', false], ['f.bat', 'sub/f.bat', true],
      ['/f.bat', 'f.bat', true], ['/f.bat', 'sub/f.bat', false], ['sub/*.bat', 'sub/f.bat', true], ['sub/*.bat', 'sub/deep/f.bat', false],
      ['sub/**', 'sub/deep/f.bat', true], ['**/f.bat', 'f.bat', true], ['**/f.bat', 'a/b/f.bat', true], ['a/**/b', 'a/b', true],
      ['a/**/b', 'a/x/y/b', true], ['a**b', 'a/xb', false], ['a**b', 'axxb', true], ['?.bat', 'f.bat', true], ['?.bat', 'ff.bat', false],
      ['[a-c]*', 'b', true], ['[a-c]*', 'd', false], ['[!a]*', 'a', false], ['[^a]*', 'b', true], ['[]a]*', ']x', true], ['[a-]x', '-x', true],
      ['[z-a]x', 'zx', true], ['a\\*b', 'a*b', true], ['a\\*b', 'axb', false], ['*/', 'a', false], ['sub/', 'sub/f', false], ['x[', 'x[', false],
      ['a/*/b', 'a/x/b', true], ['a/*/b', 'a/x/y/b', false], ['*/f.bat', 'sub/f.bat', true], ['*/f.bat', 'a/sub/f.bat', false],
      ['**', 'any/thing', true], ['F.bat', 'f.bat', false], ['*.[bB]at', 'f.Bat', true], ['\\!x', '!x', true], ['[\\]]x', ']x', true],
      // A pattern's literal start is taken off first, so a `**` right after
      // it crosses a `/`, as one after any other character does not.
      ['/c**', 'c/x/y', true], ['c**/d', 'c/x/d', true], ['a/b**', 'a/bc/d', true], ['a/b*', 'a/bc/d', false],
      // A `*` that cannot reach its literal before a `/` leaves the `**`
      // around it to try the next directory.
      ['**/*.bat', 'sub/f.bat', true], ['**/b*c', 'a/bx/bc', true], ['a/**/b*c', 'a/bx/by/bc', true], ['**/b*c/**', 'a/bx/bc/d', true],
    ]) {
      assert.equal(attributesOf(root(`${pattern} hit\n`), path).get('hit') === true, expected, `${pattern} ${path}`)
    }
  })

  it('takes each attribute from the deepest file and its last line, a macro expanded where it is set', () => {
    const top = root('[attr]win text eol=crlf\n*.bat win\n*.bat -diff\n[attr]win text eol=lf\n*.cmd text binary\n*.ps1 binary text\nsub/** !eol\n')
    const sub = below(top, 'sub/', '[attr]local text\n*.bat local eol=crlf\n*.bad bad/name text\n!neg text\n')
    assert.deepEqual(states(top, 'f.bat'), { diff: false, text: true, win: true, eol: 'lf' })
    // A macro only the root defines; a line with a name that is none, and a
    // negative pattern, left out.
    assert.deepEqual(states(sub, 'sub/f.bat'), { diff: false, text: true, win: true, eol: 'crlf', local: true })
    assert.deepEqual(states(top, 'x.cmd'), { binary: true, diff: false, merge: false, text: false })
    assert.deepEqual(states(top, 'x.ps1'), { binary: true, diff: false, merge: false, text: true })
    assert.deepEqual(states(sub, 'sub/x.bad'), { eol: null })
    assert.deepEqual(states(sub, 'sub/neg'), { eol: null })
  })
})

describe('withAttributes', () => {
  it('refuses what git versions read apart, or this does not read as git does, and all below it', () => {
    for (const text of ['"f.bat" text\n', '[[:alpha:]]* text\n', 'ï»¿*.bat text\n', `*.bat ${'x'.repeat(2048)}\n`, '*.bat builtin_x\n', '[attr]builtin_x text\n']) {
      assert.equal(root(text), null, JSON.stringify(text.slice(0, 20)))
    }
    assert.equal(withAttributes([], '', { length: 100 * 1024 * 1024 }), null)
    // A .gitattributes that is no file, and any below one refused.
    assert.equal(withAttributes([], '', null), null)
    assert.equal(withAttributes(null, 'sub/', Buffer.from('*.bat text\n')), null)
  })

  it('reads a .gitattributes as git does from a tree, none as empty', () => {
    assert.deepEqual(withAttributes([], '', undefined), [{ base: '', rules: [], macros: new Map() }])
    // A comment or a long blank line is none of the refused, and a `[attr]`
    // line below the root is left out as git leaves it.
    assert.deepEqual(root(`# "quoted" [[:alpha:]] builtin_x\n${' '.repeat(3000)}\n*.bat text\n`), [{ base: '', rules: [{ pattern: '*.bat', states: [['text', true]] }], macros: new Map() }])
    assert.deepEqual(below(root(''), 'sub/', '[attr]win text\n')[1], { base: 'sub/', rules: [], macros: new Map() })
    // Read to the first NUL, as git does.
    assert.deepEqual(root('*.bat text\n\0*.cmd text\n')[0].rules.map(({ pattern }) => pattern), ['*.bat'])
  })
})

describe('writtenWithCrlf', () => {
  const CRLF = Buffer.from('one\r\ntwo\r\n', 'latin1')

  it('is true where git writes the file with CRLF, as `git archive` wrote each', () => {
    for (const [attributes, expected] of [
      ['crlf=input eol=crlf', true], ['text=true eol=crlf', true], ['!text eol=crlf', true], ['text=input eol=crlf', true], ['-text eol=crlf', false],
      ['text=auto eol=crlf', true], ['crlf eol=crlf', true], ['-crlf eol=crlf', false], ['text', false], ['eol=lf', false], ['', false],
    ]) assert.equal(writtenWithCrlf(root(`f ${attributes}\n`), 'f', CRLF), expected, attributes)
  })

  it('is true for `text=auto` only on text: no NUL, no CR but before an LF, and few bytes that do not print', () => {
    const files = root('* text=auto eol=crlf\n')
    for (const [text, expected] of [['one\r\ntwo\u001A', true], ['one\r\n\u0000two\r\n', false], ['one\rtwo\r\n', false], [`${'\u0001'.repeat(2)}${'x'.repeat(200)}\r\n`, false], [`\u0001${'x'.repeat(200)}\r\n`, true]]) {
      assert.equal(writtenWithCrlf(files, 'f', Buffer.from(text, 'latin1')), expected, JSON.stringify(text.slice(0, 12)))
    }
  })

  it('is false for what rewrites a file otherwise, and for attributes it cannot read', () => {
    for (const other of ['ident', 'filter=x', 'working-tree-encoding=UTF-16']) assert.equal(writtenWithCrlf(root(`f text eol=crlf ${other}\n`), 'f', CRLF), false, other)
    assert.equal(writtenWithCrlf(null, 'f', CRLF), false)
  })
})
