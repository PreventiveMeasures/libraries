import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'node:test'

import { attributesOf, parseAttributes, writtenWithCrlf } from '../src/attributes.js'

const read = (text, root = true) => parseAttributes(Buffer.from(text, 'latin1'), root)
const file = (text, base = '') => ({ base, ...read(text, base === '') })
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
    ]) {
      assert.equal(attributesOf([file(`${pattern} hit\n`)], path).get('hit') === true, expected, `${pattern} ${path}`)
    }
  })

  it('takes each attribute from the deepest file and its last line, a macro expanded where it is set', () => {
    const root = file('[attr]win text eol=crlf\n*.bat win\n*.bat -diff\n[attr]win text eol=lf\n*.cmd text binary\n*.ps1 binary text\nsub/** !eol\n')
    const sub = file('[attr]local text\n*.bat local eol=crlf\n*.bad bad/name text\n!neg text\n', 'sub/')
    assert.deepEqual(states([root], 'f.bat'), { diff: false, text: true, win: true, eol: 'lf' })
    // A macro only the root defines; a line with a name that is none, and a
    // negative pattern, left out.
    assert.deepEqual(states([root, sub], 'sub/f.bat'), { diff: false, text: true, win: true, eol: 'crlf', local: true })
    assert.deepEqual(states([root], 'x.cmd'), { binary: true, diff: false, merge: false, text: false })
    assert.deepEqual(states([root], 'x.ps1'), { binary: true, diff: false, merge: false, text: true })
    assert.deepEqual(states([root, sub], 'sub/x.bad'), { eol: null })
    assert.deepEqual(states([root, sub], 'sub/neg'), { eol: null })
  })
})

describe('parseAttributes', () => {
  it('refuses what git versions read apart, or this does not read as git does', () => {
    for (const text of ['"f.bat" text\n', '[[:alpha:]]* text\n', 'ï»¿*.bat text\n', `*.bat ${'x'.repeat(2048)}\n`, '*.bat builtin_x\n', '[attr]builtin_x text\n']) {
      assert.equal(read(text), null, JSON.stringify(text.slice(0, 20)))
    }
    assert.equal(parseAttributes({ length: 100 * 1024 * 1024 }, true), null)
    // A comment or a long blank line is none of those, and a `[attr]` line
    // below the root is left out as git leaves it.
    assert.deepEqual(read(`# "quoted" [[:alpha:]] builtin_x\n${' '.repeat(3000)}\n*.bat text\n`), { rules: [{ pattern: '*.bat', states: [['text', true]] }], macros: new Map() })
    assert.deepEqual(read('[attr]win text\n', false), { rules: [], macros: new Map() })
    // Read to the first NUL, as git does.
    assert.deepEqual(read('*.bat text\n\0*.cmd text\n').rules.map(({ pattern }) => pattern), ['*.bat'])
  })
})

describe('writtenWithCrlf', () => {
  const CRLF = Buffer.from('one\r\ntwo\r\n', 'latin1')

  it('is true where git writes the file with CRLF, as `git archive` wrote each', () => {
    const root = file('*.a crlf=input eol=crlf\n*.b text=true eol=crlf\n*.c !text eol=crlf\n*.d text=input eol=crlf\n*.e -text eol=crlf\n*.h text=auto eol=crlf\n*.i crlf eol=crlf\n*.j -crlf eol=crlf\n*.k text\n*.l eol=lf\n')
    for (const [path, expected] of [['t.a', true], ['t.b', true], ['t.c', true], ['t.d', true], ['t.e', false], ['t.h', true], ['t.i', true], ['t.j', false], ['t.k', false], ['t.l', false], ['t.none', false]]) {
      assert.equal(writtenWithCrlf([root], path, CRLF), expected, path)
    }
  })

  it('is true for `text=auto` only on text: no NUL, no CR but before an LF, and few bytes that do not print', () => {
    const root = file('* text=auto eol=crlf\n')
    for (const [text, expected] of [['one\r\ntwo\u001A', true], ['one\r\n\u0000two\r\n', false], ['one\rtwo\r\n', false], [`${'\u0001'.repeat(2)}${'x'.repeat(200)}\r\n`, false], [`\u0001${'x'.repeat(200)}\r\n`, true]]) {
      assert.equal(writtenWithCrlf([root], 'f', Buffer.from(text, 'latin1')), expected, JSON.stringify(text.slice(0, 12)))
    }
  })

  it('is false for what rewrites a file otherwise, and for attributes it cannot read', () => {
    const root = file('*.f text eol=crlf ident\n*.g text eol=crlf filter=x\n*.w text eol=crlf working-tree-encoding=UTF-16\n*.bat text eol=crlf\n')
    for (const path of ['t.f', 't.g', 't.w']) assert.equal(writtenWithCrlf([root], path, CRLF), false, path)
    assert.equal(writtenWithCrlf([root], 'x.bat', CRLF), true)
    assert.equal(writtenWithCrlf([root, null], 'sub/x.bat', CRLF), false)
  })
})
