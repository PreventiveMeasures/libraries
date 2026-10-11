import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DiffError } from '@preventive/diff'
import { CompareError, compareLines, compareTrees, formatPatch } from '../compare.js'
import { entriesOf } from './git.js'
import { treePair } from './random.js'

// What a bundle's comparison asks beyond git's: names that are keys and no
// tree's paths, renames kept within a package, the placement and comparison
// of lines a viewer chooses, and statuses first with lines found per file.

const tree = (files) => Object.entries(files).map(([name, data]) => ({ name, data }))
const summary = (changes) => changes.map(({ status, old, new: fresh }) => (status === 'renamed' ? `${old.path} -> ${fresh.path}` : `${status} ${(fresh ?? old).path}`))

describe("paths: 'keys'", () => {
  const KEYS = ['webpack://app/src/a.js', '../node_modules/x/a.js', '/abs/a.js', './a.js', 'a', 'a/b']

  it('takes names as they are, which a tree would refuse', () => {
    assert.throws(() => compareTrees(tree({ [KEYS[0]]: 'x' }), []), CompareError)
    const changes = compareTrees(tree(Object.fromEntries(KEYS.map((key) => [key, `${key}\n`]))), tree({ 'a': 'changed\n' }), { paths: 'keys', renames: false })
    assert.deepEqual(summary(changes).toSorted(), [...KEYS.filter((key) => key !== 'a').map((key) => `deleted ${key}`), 'modified a'].toSorted())
  })

  it('still takes a name once, and one that is not empty and has UTF-8', () => {
    for (const entries of [[{ name: 'k' }, { name: 'k' }], [{ name: '' }], [{ name: 'a\u{D800}' }]]) assert.throws(() => compareTrees(entries, [], { paths: 'keys' }), CompareError)
    assert.throws(() => compareTrees([], [], { paths: 'flat' }), RangeError)
  })

  it('tells renames by path in keys with empty segments', () => {
    const changes = compareTrees(tree({ 'webpack://app/lib/a.js': 'one\ntwo\nthree\n' }), tree({ 'webpack://app/src/a.ts': 'uno\ndos\ntres\n' }), { paths: 'keys' })
    assert.deepEqual(summary(changes), ['webpack://app/lib/a.js -> webpack://app/src/a.ts'])
  })
})

describe('renameGroup', () => {
  const MIT = 'MIT License\n\nPermission is hereby granted, free of charge...\n'
  const pkg = (path) => path.split('/')[1]

  it('keeps renames within a group', () => {
    const before = tree({ 'node_modules/left-pad/LICENSE': MIT, 'node_modules/left-pad/a.js': 'x\n' })
    const after = tree({ 'node_modules/pad-left/LICENSE': MIT, 'node_modules/left-pad/b.js': 'x\n' })
    assert.deepEqual(summary(compareTrees(before, after)), ['node_modules/left-pad/a.js -> node_modules/left-pad/b.js', 'node_modules/left-pad/LICENSE -> node_modules/pad-left/LICENSE'])
    assert.deepEqual(summary(compareTrees(before, after, { renameGroup: pkg })), ['deleted node_modules/left-pad/LICENSE', 'node_modules/left-pad/a.js -> node_modules/left-pad/b.js', 'added node_modules/pad-left/LICENSE'])
  })

  it('takes a function', () => {
    assert.throws(() => compareTrees([], [], { renameGroup: 'pkg' }), TypeError)
  })
})

describe('slide', () => {
  // Two trailing blank lines, one of which goes: diff -u and the search put it apart.
  const after = { f: 'a\n\n' }, before = { f: '\na\n\n\n' }
  const at = (options) => compareTrees(tree(before), tree(after), options)[0].blocks.map(({ a0, a1 }) => [a0, a1])

  it('settles a free run where -u does, or leaves it where the search found it', () => {
    assert.deepEqual(at(), [[0, 1], [3, 4]])
    assert.deepEqual(at({ slide: false }), [[0, 1], [2, 3]])
    assert.throws(() => compareTrees([], [], { slide: 'no' }), TypeError)
  })

  it('prints either in a patch', () => {
    const hunks = (options) => formatPatch(compareTrees(tree(before), tree(after), options), { context: 0 }).split('\n').slice(3).join('\n')
    assert.equal(hunks(), '@@ -1 +0,0 @@\n-\n@@ -4 +2,0 @@ a\n-\n')
    assert.equal(hunks({ slide: false }), '@@ -1 +0,0 @@\n-\n@@ -3 +1,0 @@ a\n-\n')
  })
})

describe('lines: false, and compareLines', () => {
  it('gives statuses alone, and the same lines later', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { old, new: fresh } = treePair(seed)
      const full = compareTrees(entriesOf(old), entriesOf(fresh))
      const statuses = compareTrees(entriesOf(old), entriesOf(fresh), { lines: false })
      assert.deepEqual(statuses, full.map(({ status, old: from, new: to, similarity }) => ({ status, old: from, new: to, similarity })), `seed ${seed}`)
      assert.deepEqual(statuses.map((change) => compareLines(change)), full, `seed ${seed}`)
      assert.equal(formatPatch(statuses), formatPatch(full), `seed ${seed}`)
    }
  })

  it('finds lines under the options it is given', () => {
    const [change] = compareTrees(tree({ f: '\na\n\n\n' }), tree({ f: 'a\n\n' }), { lines: false })
    assert.deepEqual(compareLines(change, { slide: false }).blocks.map(({ a0 }) => a0), [0, 2])
    assert.throws(() => compareLines(change, { whitespace: 'some' }), RangeError)
    assert.throws(() => compareTrees([], [], { lines: 'no' }), TypeError)
  })
})

describe('whitespace and ignoreCase', () => {
  const after = tree({ f: 'a b\nc\n', g: 'hello\n' }), before = tree({ f: 'a  b\nc\n', g: 'Hello\n' })

  it('call lines the same as diff -w, -b, -Z and -i do, the files still modified', () => {
    const changes = compareTrees(before, after, { whitespace: 'change', ignoreCase: true })
    assert.deepEqual(changes.map(({ status, blocks, insertions, deletions }) => [status, blocks, insertions, deletions]), [['modified', [], 0, 0], ['modified', [], 0, 0]])
    assert.deepEqual(compareTrees(before, after).map(({ insertions }) => insertions), [1, 1])
  })

  it('print as git diff -w does, nothing for a file whose lines are all the same, and must be given to formatPatch', () => {
    const changes = compareTrees(before, after, { whitespace: 'all', ignoreCase: true })
    assert.equal(formatPatch(changes, { whitespace: 'all', ignoreCase: true }), '')
    assert.throws(() => formatPatch(changes), DiffError)
    assert.throws(() => compareTrees([], [], { whitespace: 'some' }), RangeError)
    assert.throws(() => compareTrees([], [], { ignoreCase: 'yes' }), TypeError)
  })
})
