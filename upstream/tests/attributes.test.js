import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, it } from 'node:test'

import { withAttributes, writtenWithCrlf } from '../src/attributes.js'

const below = (above, base, text) => withAttributes(above, base, Buffer.from(text, 'latin1'))
const root = (text) => below([], '', text)

// Expectations are what `git archive` (git 2.43) wrote, but for those refused.
describe('writtenWithCrlf', () => {
  const CRLF = Buffer.from('one\r\ntwo\r\n', 'latin1')

  it('is true where the attributes have git write the file with CRLF', () => {
    for (const [attributes, expected] of [
      ['crlf=input eol=crlf', true], ['text=true eol=crlf', true], ['!text eol=crlf', true], ['text=input eol=crlf', true], ['crlf eol=crlf', true],
      ['-text eol=crlf', false], ['-crlf eol=crlf', false], ['binary eol=crlf', false], ['text binary eol=crlf', false], ['binary text eol=crlf', true],
      ['text', false], ['eol=lf', false], ['', false],
    ]) assert.equal(writtenWithCrlf(root(`f ${attributes}\n`), 'f', CRLF), expected, attributes)
  })

  it('matches `*`, `*.ext`, a name and a path, the deepest file and its last line first', () => {
    const top = root('* text eol=crlf\n*.png binary\n*.bat eol=lf\nf.bat eol=crlf\n/x.md -text\ndocs/y.md -text\nsub/ -text\n')
    const sub = below(top, 'sub/', '*.txt -text\n')
    for (const [files, path, expected] of [
      [top, 'a.txt', true], [top, 'a.png', false], [top, 'g.bat', false], [top, 'f.bat', true], [top, 'sub/f.bat', true],
      [top, 'x.md', false], [top, 'sub/x.md', true], [top, 'docs/y.md', false], [top, 'y.md', true], [top, 'sub/z', true],
      [sub, 'sub/a.txt', false], [sub, 'sub/a.png', false], [sub, 'sub/a.c', true],
    ]) assert.equal(writtenWithCrlf(files, path, CRLF), expected, path)
  })

  it('is true for `text=auto` only on text', () => {
    const files = root('* text=auto eol=crlf\n')
    for (const [text, expected] of [['one\r\ntwo\u001A', true], ['one\r\n\u0000two\r\n', false], ['one\rtwo\r\n', false], [`${'\u0001'.repeat(2)}${'x'.repeat(200)}\r\n`, false], [`\u0001${'x'.repeat(200)}\r\n`, true]]) {
      assert.equal(writtenWithCrlf(files, 'f', Buffer.from(text, 'latin1')), expected, JSON.stringify(text.slice(0, 12)))
    }
  })

  it('is false for what rewrites a file otherwise, and for refused attributes', () => {
    for (const other of ['ident', 'filter=x', 'working-tree-encoding=UTF-16']) assert.equal(writtenWithCrlf(root(`f text eol=crlf ${other}\n`), 'f', CRLF), false, other)
    assert.equal(writtenWithCrlf(null, 'f', CRLF), false)
  })
})

describe('withAttributes', () => {
  it('refuses a rule it does not read, and all below it', () => {
    for (const text of ['**/*.bat eol=crlf\n', 'sub/*.bat -text\n', '[attr]win text eol=crlf\n', '"f.bat" -text\n']) assert.equal(root(text), null, text)
    assert.equal(withAttributes([], '', null), null)
    assert.equal(withAttributes(null, 'sub/', Buffer.from('')), null)
  })

  it('passes over rules for other attributes, and lines git leaves out', () => {
    assert.deepEqual(withAttributes([], '', undefined), [{ base: '', rules: [] }])
    assert.equal(root('# "comment"\n**/*.png linguist-generated\n[attr]gen linguist-generated\n!f -text\nf bad/name -text\nf -text\n\0f text\n')[0].rules.length, 1)
  })
})
