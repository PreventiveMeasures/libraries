import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeptreeError } from '../pnpm.js'
import { checkPatchOfBins, fixBin } from '../src/pnpm/bins.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const file = (text, mode = 0o644) => ({ data: typeof text === 'string' ? encoder.encode(text) : text, mode })
const filesOf = (entries) => new Map(Object.entries(entries).map(([path, text]) => [path, file(text)]))

describe('fixBin', () => {
  it('makes a file executable, and a CRLF ending its #! line LF', () => {
    assert.deepEqual(fixBin(file('#!/usr/bin/env node\nrun()\r\n'), 'x'), file('#!/usr/bin/env node\nrun()\r\n', 0o755))
    assert.equal(decoder.decode(fixBin(file('#!/usr/bin/env node\r\nrun()\r\n'), 'x').data), '#!/usr/bin/env node\nrun()\r\n')
    // Only a #! line with something after the #! that ends in CRLF.
    assert.equal(decoder.decode(fixBin(file('#!\r\nx'), 'x').data), '#!\r\nx')
    assert.equal(decoder.decode(fixBin(file('x\r\n'), 'x').data), 'x\r\n')
  })

  it('refuses a CRLF #! line in a file that is not UTF-8, which pnpm would rewrite', () => {
    assert.throws(() => fixBin(file(new Uint8Array([0x23, 0x21, 0x78, 0x0d, 0x0a, 0xff])), 'x'), (error) => error instanceof DeptreeError && /is not UTF-8/u.test(error.message))
  })
})

// A patch is applied between two times pnpm links its package's bins.
describe('checkPatchOfBins', () => {
  const manifest = { name: 'x', version: '1.0.0', bin: { x: 'cli.js' }, directories: { doc: 'doc' } }
  const node = { key: 'x@1.0.0', dir: 'node_modules/.pnpm/x@1.0.0/node_modules/x', manifest, files: filesOf({ 'package.json': JSON.stringify(manifest), 'cli.js': '#!/usr/bin/env node\n', 'lib.js': '' }) }
  const patched = (changes) => {
    const files = new Map(node.files)
    for (const [path, text] of Object.entries(changes)) {
      if (text === undefined) files.delete(path)
      else files.set(path, file(text))
    }
    return files
  }
  const check = (changes) => checkPatchOfBins(node, patched(changes), new Set(['cli.js']), 'x')

  it('lets a patch change what of package.json linking bins does not read', () => {
    check({ 'lib.js': 'changed', 'cli.js': '#!/usr/bin/env node\nchanged\n', 'package.json': JSON.stringify({ ...manifest, description: 'd', directories: { doc: 'docs' } }) })
  })

  const refused = [
    ['a change to its bins', { 'package.json': JSON.stringify({ ...manifest, bin: { x: 'lib.js' } }) }, /changes the name or bins/u],
    ['a change to directories.bin', { 'package.json': JSON.stringify({ ...manifest, directories: { bin: 'bin' } }) }, /changes the name or bins/u],
    ['a bin\'s file removed', { 'cli.js': undefined }, /makes or removes "cli\.js"/u],
    ['a change to a bin with a CRLF #! line', { 'cli.js': '#!/usr/bin/env node\r\nx\n' }, /a bin with a CRLF/u],
    ['package.json removed', { 'package.json': undefined }, /removes package\.json/u],
  ]
  for (const [what, changes, pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => check(changes), (error) => error instanceof DeptreeError && pattern.test(error.message)))
  }
})
