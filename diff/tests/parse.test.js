import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyChangeSet } from '../src/apply.js'
import { splitRecords } from '../src/compare.js'
import { formatContext, formatNormal, formatUnified } from '../src/format.js'
import { DiffError, diffLines } from '../src/myers.js'
import { PatchError, parseDiff } from '../src/parse.js'
import { FILES, RECORDINGS } from './fixtures/gnu-diff.js'

// Reading is held to writing: whatever this package prints, it reads back
// into the change set it printed. That closes the one thing the search's own
// guarantee never covered — the search promises the change set reconstructs
// the second file, but nothing promised the bytes said so.

const positions = (blocks) => blocks.map(({ a0, a1, b0, b1 }) => [a0, a1, b0, b1].join(','))

const STYLES = [
  ['normal', (a, b, bl) => formatNormal(a, b, bl)],
  ['unified', (a, b, bl) => formatUnified(a, b, bl, { context: 3, header: '--- x\n+++ y\n', label: null })],
  ['unified, no context', (a, b, bl) => formatUnified(a, b, bl, { context: 0, header: '--- x\n+++ y\n', label: null })],
  ['context', (a, b, bl) => formatContext(a, b, bl, { context: 3, header: '*** x\n--- y\n', label: null })],
]

describe('what is printed is read back', () => {
  for (const [name, render] of STYLES) {
    it(`${name}, on a file with a change of every shape`, () => {
      const a = splitRecords('keep\ndrop\nkeep2\nsame\nold\n\nblank\ntail\n')
      const b = splitRecords('keep\nkeep2\nsame\nnew1\nnew2\n\nblank\ntail\nadded\n')
      const blocks = diffLines(a, b)
      const [file] = parseDiff(render(a, b, blocks))
      assert.deepEqual(positions(file.blocks), positions(blocks))
      assert.deepEqual(applyChangeSet(a, file.blocks), b, 'the lines the diff carries rebuild the second file')
    })
  }

  it('a last line with no terminator, in both directions', () => {
    for (const [a, b] of [[splitRecords('x\n'), splitRecords('x')], [splitRecords('x'), splitRecords('x\n')]]) {
      for (const [name, render] of STYLES) {
        const blocks = diffLines(a, b)
        const [file] = parseDiff(render(a, b, blocks))
        assert.deepEqual(positions(file.blocks), positions(blocks), name)
        assert.deepEqual(applyChangeSet(a, file.blocks), b, name)
      }
    }
  })
})

// A small seeded generator (a 32-bit LCG), so a failing case can be replayed.
function random(seed) {
  let state = seed
  return () => {
    state = Math.imul(state, 1664525) + 1013904223
    return ((state >>> 8) & 0xFFFFFF) / 0x1000000
  }
}

describe('what is printed is read back, on thousands of diffs', () => {
  // Blank lines and a missing last terminator are in the alphabet because
  // both are written with markers of their own, and both are where a reader
  // that only handles ordinary lines comes apart.
  const draw = (next) => {
    const length = Math.floor(next() * 10)
    return Array.from({ length }, (_, i) => {
      const pick = Math.floor(next() * 5)
      if (pick === 4) return i === length - 1 ? 'z' : 'z\n'
      return ['a\n', 'b\n', '\n', 'c\n'][pick]
    })
  }
  for (const [name, render] of STYLES) {
    it(name, () => {
      const next = random(20260915)
      let checked = 0
      for (let round = 0; round < 1500; round++) {
        const a = draw(next), b = draw(next)
        const blocks = diffLines(a, b)
        if (blocks.length === 0) continue
        const text = render(a, b, blocks)
        const replay = `round ${round}: ${JSON.stringify([a.join(''), b.join('')])}`
        const files = parseDiff(text)
        assert.equal(files.length, 1, replay)
        assert.deepEqual(positions(files[0].blocks), positions(blocks), replay)
        assert.deepEqual(applyChangeSet(a, files[0].blocks), b, replay)
        checked++
      }
      assert.ok(checked > 1000, `only ${checked} of the rounds had a change to print`)
    })
  }
})

describe("diff's own output reads back the same, whatever format it is in", () => {
  // The same recordings format.test.js renders against, read the other way:
  // every format a pair was recorded in has to yield that pair's change set.
  const byPair = new Map()
  for (const recording of RECORDINGS) {
    const [a, b] = recording.names.map((name) => splitRecords(FILES[name]))
    it(recording.command, () => {
      const files = parseDiff(recording.stdout)
      assert.equal(files.length, 1)
      const { blocks } = files[0]
      assert.equal(files[0].format, recording.format)
      assert.deepEqual(applyChangeSet(a, blocks), b, 'the lines the diff carries rebuild the second file')
      const seen = byPair.get(recording.names.join(' '))
      if (seen) assert.deepEqual(positions(blocks), seen, `differs from what ${recording.command} read back`)
      byPair.set(recording.names.join(' '), positions(blocks))
    })
  }
})

describe('the header names the files, when it is there to', () => {
  it('reads a unified header', () => {
    const [file] = parseDiff('--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-a\n+b\n')
    assert.deepEqual([file.old, file.new, file.format], ['old.txt', 'new.txt', 'unified'])
  })
  it('reads a context header, and does not take the range lines for it', () => {
    const [file] = parseDiff('*** old.txt\n--- new.txt\n***************\n*** 1 ****\n! a\n--- 1 ----\n! b\n')
    assert.deepEqual([file.old, file.new, file.format], ['old.txt', 'new.txt', 'context'])
  })
  it('drops a trailing timestamp, which is not part of the name', () => {
    const [file] = parseDiff('--- old.txt\t2026-09-15 00:00:00\n+++ new.txt\t2026-09-15 00:00:01\n@@ -1 +1 @@\n-a\n+b\n')
    assert.deepEqual([file.old, file.new], ['old.txt', 'new.txt'])
  })
  it('reads a git header', () => {
    const [file] = parseDiff('diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-a\n+b\n')
    assert.deepEqual([file.old, file.new], ['a/src/x.js', 'b/src/x.js'])
  })
  it('reads a git header that names both files on its own', () => {
    // Some patches carry no `---`/`+++` pair at all, and the git line is the
    // only thing that names the second file.
    const [file] = parseDiff('diff --git a/old.txt b/new.txt\n@@ -1 +1 @@\n-a\n+b\n')
    assert.deepEqual([file.old, file.new], ['a/old.txt', 'b/new.txt'])
  })
  it('leaves them null for a normal diff, which carries none', () => {
    const [file] = parseDiff('1c1\n< a\n---\n> b\n')
    assert.deepEqual([file.old, file.new, file.format], [null, null, 'normal'])
  })
  it('reads a patch that covers several files', () => {
    const files = parseDiff('--- a1\n+++ b1\n@@ -1 +1 @@\n-a\n+b\n--- a2\n+++ b2\n@@ -1 +1 @@\n-c\n+d\n')
    assert.deepEqual(files.map((f) => [f.old, f.new]), [['a1', 'b1'], ['a2', 'b2']])
    assert.deepEqual(files.map((f) => f.blocks[0].insert), [['b\n'], ['d\n']])
  })
})

describe('what cannot be read is refused, and says where', () => {
  for (const [name, text] of [
    ['a hunk that ends early', '--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n'],
    ['a hunk line with no tag', '--- x\n+++ y\n@@ -1,2 +1,2 @@\n a\n?b\n'],
    ['more lines than the header says', '--- x\n+++ y\n@@ -1 +1 @@\n-a\n-b\n+c\n'],
    ['a normal hunk missing its separator', '1c1\n< a\n> b\n'],
    ['a normal hunk whose range counts backwards', '5,2c1\n< a\n---\n> b\n'],
    ['a context hunk with no new-side range', '***************\n*** 1 ****\n! a\n'],
  ]) {
    it(name, () => {
      assert.throws(() => parseDiff(text), PatchError, name)
    })
  }
  it('names the line it stopped at', () => {
    let thrown = null
    try { parseDiff('--- x\n+++ y\n@@ -1,2 +1,2 @@\n a\n?b\n') } catch (e) { thrown = e }
    assert.ok(thrown instanceof PatchError)
    // Counted from zero on the error, from one in the message, as an editor
    // would show it.
    assert.equal(thrown.line, 4)
    assert.match(thrown.message, /line 5$/u)
  })
  it('says nothing about text that is not a diff', () => {
    assert.deepEqual(parseDiff('just some prose\nand more of it\n'), [])
    assert.deepEqual(parseDiff(''), [])
  })
})

describe('applying a change set', () => {
  const a = splitRecords('a\nb\nc\n'), b = splitRecords('a\nX\nc\n')
  it('takes the replacement from the second file', () => {
    assert.deepEqual(applyChangeSet(a, diffLines(a, b), b), b)
  })
  it('takes it from the block when the block carries its own', () => {
    assert.deepEqual(applyChangeSet(a, parseDiff('2c2\n< b\n---\n> X\n')[0].blocks), b)
  })
  it('is the identity on an empty change set', () => {
    assert.deepEqual(applyChangeSet(a, [], b), a)
  })
  it('refuses a block it cannot fill', () => {
    assert.throws(() => applyChangeSet(a, [{ a0: 1, a1: 2, b0: 1, b1: 2 }]), DiffError)
  })
  it('refuses blocks out of order or out of range', () => {
    assert.throws(() => applyChangeSet(a, [{ a0: 2, a1: 3, b0: 0, b1: 0 }, { a0: 0, a1: 1, b0: 0, b1: 0 }], b), DiffError)
    assert.throws(() => applyChangeSet(a, [{ a0: 0, a1: 9, b0: 0, b1: 0 }], b), DiffError)
  })
  it('refuses a replacement range the second file does not have', () => {
    // `slice` clips a range past the end and empties a reversed one, either
    // way handing back a plausible wrong answer rather than failing.
    for (const range of [{ b0: 1, b1: 99 }, { b0: 2, b1: 1 }, { b0: -1, b1: 1 }]) {
      assert.throws(() => applyChangeSet(a, [{ a0: 1, a1: 2, ...range }], b), DiffError, JSON.stringify(range))
    }
  })
})
