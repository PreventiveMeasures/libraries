import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyChangeSet, parseDiff } from '@preventive/diff'
import { compareTrees, formatPatch } from '../compare.js'
import { entriesOf } from './git.js'
import { treePair } from './random.js'

// What each change holds. Which files git calls changed or renamed, and the
// patch it writes, are git.test.js's; this is the rest of the record.

const bytes = (text) => new TextEncoder().encode(text)
const decode = (data) => new TextDecoder().decode(data)

describe('each change says what became of one file', () => {
  it('says nothing of trees that are the same', () => {
    const tree = [{ name: 'a', data: 'a\n' }, { name: 'l', type: 'symlink', linkname: 'a' }]
    assert.deepEqual(compareTrees(tree, tree), [])
    assert.deepEqual(compareTrees([], []), [])
  })

  it('holds both sides, the change set between them, and its counts', () => {
    const [change] = compareTrees([{ name: 'src/a.js', data: 'one\ntwo\nthree\nfour\nfive\n' }], [{ name: 'lib/a.js', data: 'one\nTWO\nthree\nfour\nfive\nsix\n' }])
    assert.deepEqual(change, {
      status: 'renamed',
      old: { path: 'src/a.js', type: 'file', mode: 0o644, data: bytes('one\ntwo\nthree\nfour\nfive\n') },
      new: { path: 'lib/a.js', type: 'file', mode: 0o644, data: bytes('one\nTWO\nthree\nfour\nfive\nsix\n') },
      similarity: 71,
      binary: false,
      blocks: [
        { a0: 1, a1: 2, b0: 1, b1: 2, remove: ['two\n'], insert: ['TWO\n'] },
        { a0: 5, a1: 5, b0: 5, b1: 6, remove: [], insert: ['six\n'] },
      ],
      insertions: 2,
      deletions: 1,
    })
  })

  it('counts an added file against nothing, and a deleted one likewise', () => {
    const changes = compareTrees([{ name: 'gone', data: 'a\nb\n' }], [{ name: 'here', data: 'x\n' }, { name: 'empty' }], { renames: false })
    assert.deepEqual(changes.map(({ status, similarity, blocks, insertions, deletions }) => ({ status, similarity, blocks, insertions, deletions })), [
      { status: 'added', similarity: null, blocks: [], insertions: 0, deletions: 0 },
      { status: 'deleted', similarity: null, blocks: [{ a0: 0, a1: 2, b0: 0, b1: 0, remove: ['a\n', 'b\n'], insert: [] }], insertions: 0, deletions: 2 },
      { status: 'added', similarity: null, blocks: [{ a0: 0, a1: 0, b0: 0, b1: 1, remove: [], insert: ['x\n'] }], insertions: 1, deletions: 0 },
    ])
  })

  it('takes a link for its target, and a type change for one content becoming the other', () => {
    const changes = compareTrees(
      [{ name: 'l', type: 'symlink', linkname: 'a' }, { name: 't', data: 'text\n' }],
      [{ name: 'l', type: 'symlink', linkname: 'b' }, { name: 't', type: 'symlink', linkname: 'elsewhere' }],
    )
    assert.deepEqual(changes.map(({ status, old, new: fresh, blocks }) => ({ status, old, new: fresh, blocks })), [
      { status: 'modified', old: { path: 'l', type: 'symlink', target: 'a' }, new: { path: 'l', type: 'symlink', target: 'b' }, blocks: [{ a0: 0, a1: 1, b0: 0, b1: 1, remove: ['a'], insert: ['b'] }] },
      { status: 'type-changed', old: { path: 't', type: 'file', mode: 0o644, data: bytes('text\n') }, new: { path: 't', type: 'symlink', target: 'elsewhere' }, blocks: [{ a0: 0, a1: 1, b0: 0, b1: 1, remove: ['text\n'], insert: ['elsewhere'] }] },
    ])
  })

  it('has no lines for binary content, and no counts, as numstat has none', () => {
    const changes = compareTrees(
      [{ name: 'nul', data: 'a\0b\n' }, { name: 'latin1', data: Uint8Array.of(0x63, 0x61, 0x66, 0xE9, 0x0A) }, { name: 'same', data: 'x\0', mode: 0o644 }],
      [{ name: 'nul', data: 'a\0c\n' }, { name: 'latin1', data: Uint8Array.of(0x63, 0x61, 0x66, 0xE8, 0x0A) }, { name: 'same', data: 'x\0', mode: 0o755 }],
    )
    for (const change of changes) assert.deepEqual([change.binary, change.blocks, change.insertions, change.deletions], [true, [], null, null], change.old.path)
  })

  it('compares every permission bit of a file, where git keeps only the one', () => {
    const [change] = compareTrees([{ name: 'tool', data: 'x\n', mode: 0o755 }], [{ name: 'tool', data: 'x\n', mode: 0o4755 }])
    assert.deepEqual([change.status, change.old.mode, change.new.mode, change.blocks], ['modified', 0o755, 0o4755, []])
    assert.equal(formatPatch([change]), 'diff --git a/tool b/tool\nold mode 100755\nnew mode 104755\n')
  })

  it('goes in code point order, which is the UTF-8 byte order git sorts by', () => {
    const names = ['b', 'a0', 'a/b', 'a.c', 'a-b', '\u{E000}', '\u{10000}', 'B']
    const changes = compareTrees([], names.map((name) => ({ name, data: name })), { renames: false })
    assert.deepEqual(changes.map((change) => change.new.path), ['B', 'a-b', 'a.c', 'a/b', 'a0', 'b', '\u{E000}', '\u{10000}'])
  })

  it('stands a rename where its new path is', () => {
    const changes = compareTrees([{ name: 'z', data: 'moved\n' }, { name: 'm', data: 'kept\n' }], [{ name: 'a', data: 'moved\n' }, { name: 'm', data: 'kept!\n' }])
    assert.deepEqual(changes.map(({ status, new: fresh }) => [status, fresh.path]), [['renamed', 'a'], ['modified', 'm']])
  })
})

describe('the change set is the one that rebuilds the new file', () => {
  // Over the random pairs git-live.test.js holds to git: every text change's
  // blocks carry its old content to its new one, and are the blocks its own
  // section of the patch says.
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, () => {
      const pair = treePair(seed)
      for (const change of compareTrees(entriesOf(pair.old), entriesOf(pair.new))) {
        if (change.binary) continue
        const text = (side) => (side === null ? '' : side.type === 'symlink' ? side.target : decode(side.data))
        assert.equal(applyChangeSet(text(change.old), change.blocks), text(change.new))
        if (change.status === 'type-changed') continue
        const read = parseDiff(formatPatch([change]))
        assert.deepEqual(read.flatMap((file) => file.blocks), change.blocks)
      }
    })
  }
})

describe('the options are git diff\'s', () => {
  const old = [{ name: 'a', data: 'one\ntwo\nthree\nfour\n' }]
  const fresh = [{ name: 'b', data: 'one\ntwo\nthree\nFOUR\n' }]
  const statuses = (options) => compareTrees(old, fresh, options).map((change) => change.status)

  it('finds renames at 50% unless told otherwise', () => {
    assert.deepEqual(statuses(), ['renamed'])
    assert.deepEqual(statuses({ renames: true }), ['renamed'])
    assert.deepEqual(statuses({ renames: 70 }), ['renamed'])
    assert.deepEqual(statuses({ renames: 75.5 }), ['deleted', 'added'])
    assert.deepEqual(statuses({ renames: false }), ['deleted', 'added'])
    assert.deepEqual(statuses({ renames: 100 }), ['deleted', 'added'])
  })

  it('looks for scored renames under the limit alone', () => {
    assert.deepEqual(statuses({ renameLimit: 0 }), ['deleted', 'added'])
    assert.deepEqual(statuses({ renameLimit: 1 }), ['renamed'])
    assert.deepEqual(statuses({ renameLimit: Infinity }), ['renamed'])
  })

  it('takes a percentage, or a whole number of files', () => {
    assert.throws(() => compareTrees([], [], { renames: 'yes' }), TypeError)
    for (const renames of [0, -1, 101, Number.NaN]) assert.throws(() => compareTrees([], [], { renames }), RangeError, String(renames))
    for (const renameLimit of [-1, 1.5, Number.NaN, '10']) assert.throws(() => compareTrees([], [], { renameLimit }), RangeError, String(renameLimit))
  })
})
