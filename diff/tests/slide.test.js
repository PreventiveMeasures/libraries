import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitRecords } from '../src/compare.js'
import { formatNormal, formatUnified } from '../src/format.js'
import { diffLines } from '../src/myers.js'
import { slideRuns } from '../src/slide.js'

// A run of changed lines bordered by equal lines can sit anywhere along
// them and mean the same edit, so the search's placement is arbitrary and
// the slide replaces it with one that isn't. The rule has three parts, and
// each is pinned on its own below before the recorded cases exercise them
// together.

// Written as strings so a case reads as the file does: `b` is a line, `.`
// marks a line the change set changed.
const flags = (marked) => Uint8Array.from(marked, (c) => (c === '.' ? 1 : 0))
const ids = (text) => Array.from(text, (c) => c.codePointAt(0))
const slid = (text, marked, otherMarked) => {
  const changed = flags(marked)
  slideRuns(ids(text), changed, flags(otherMarked))
  return Array.from(changed, (c) => (c ? '.' : '-')).join('')
}

describe('a run goes as late as the equal lines let it', () => {
  it('moves to the end of a row of its own line', () => {
    assert.equal(slid('bbb', '.--', '--'), '--.')
    assert.equal(slid('xbbby', '-.---', '----'), '---.-')
  })
  it('stays put where the bordering lines differ', () => {
    assert.equal(slid('xbcy', '--.-', '---'), '--.-')
    assert.equal(slid('abc', '.--', '--'), '.--')
  })
  it('moves a run of more than one line', () => {
    assert.equal(slid('ababab', '..----', '----'), '----..')
  })
})

describe('a run that meets another becomes one run with it', () => {
  it('swallows the run it reaches and carries on', () => {
    // Both `b`s go; sliding the first onto the second leaves one run of two.
    assert.equal(slid('bbb', '.-.', '-'), '-..')
  })
})

describe('a run comes back to sit opposite a run in the other file', () => {
  // A deletion that can sit anywhere along four `b`s, and an insertion in
  // the other file facing the third of them: the deletion goes there, so
  // the two print as one change rather than as a delete and an append.
  const a = 'baabaabbbba'
  it('stops short of the last placement to face the other run', () => {
    assert.equal(slid(a, '---.--.----', '-------.--'), '---.----.--')
  })
  it('goes all the way when there is nothing to face', () => {
    assert.equal(slid(a, '---.--.----', '----------'), '---.-----.-')
  })
})

// The strings are what GNU diff 3.10 prints for each pair. They are the
// cases where the raw search picks a placement of its own, so each of them
// fails without the slide.
describe('a run of changes is placed where GNU places it', () => {
  for (const [a, b, expected] of [
    ['b\nc\n', 'c\nc\nb\nb\n', '1d0\n< b\n2a2,4\n> c\n> b\n> b\n'],
    ['b\nb\nc\n', 'b\nc\nc\na\n', '2d1\n< b\n3a3,4\n> c\n> a\n'],
    ['b\nb\nb\na\na\na\n', 'a\nb\n', '1,5d0\n< b\n< b\n< b\n< a\n< a\n6a2\n> b\n'],
    ['b\nb\na\n', 'a\nb\na\na\na\n', '0a1\n> a\n2c3,4\n< b\n---\n> a\n> a\n'],
    ['c\na\nc\n', 'a\na\nb\nc\nc\nc\n', '1d0\n< c\n2a2,5\n> a\n> b\n> c\n> c\n'],
    ['b\na\na\na\n', 'c\nb\na\nb\na\n', '0a1\n> c\n3c4\n< a\n---\n> b\n'],
    ['b\nb\nb\n', 'b\nb\n', '3d2\n< b\n'],
    ['x\nb\nb\nb\ny\n', 'x\nb\nb\ny\n', '4d3\n< b\n'],
    ['x\nb\nb\ny\n', 'x\nb\nb\nb\ny\n', '3a4\n> b\n'],
    ['b\na\na\nb\na\na\nb\nb\nb\nb\na\n', 'b\na\na\na\na\nb\nb\na\nb\na\n', '4d3\n< b\n9c8\n< b\n---\n> a\n'],
    // A hunk in code lands after the block it follows, not before it: the
    // added lines read as `new` then a blank, never a blank then `new`.
    ['int a;\n\nint b;\n\nint c;\n', 'int a;\n\nint b;\n\nint new;\n\nint c;\n', '4a5,6\n> int new;\n> \n'],
    ['}\n\nfoo\n}\n\nbar\n}\n', '}\n\nfoo\n}\n\nnew\n}\n\nbar\n}\n', '5a6,8\n> new\n> }\n> \n'],
  ]) {
    it(JSON.stringify([a, b]), () => {
      const x = splitRecords(a), y = splitRecords(b)
      assert.equal(formatNormal(x, y, diffLines(x, y)), expected)
    })
  }
})

// diff itself only settles runs for the styles that print context lines, so
// its normal output and its `-u` output describe different change sets
// wherever a run is free to move. Neither is wrong and both are reproduced,
// from the same pair, by asking for the placement the style calls for.
describe('the placement each output style calls for', () => {
  // Blank lines are ordinary lines to diff, and because they repeat they are
  // where a free run turns up most in real code: here either of the two
  // trailing blanks can go.
  const a = splitRecords('\na\n\n\n'), b = splitRecords('a\n\n')
  it('normal prints the placement the search reached', () => {
    assert.equal(formatNormal(a, b, diffLines(a, b, { slide: false })), '1d0\n< \n3d1\n< \n')
  })
  it('unified prints the settled one', () => {
    assert.equal(formatUnified(a, b, diffLines(a, b), { context: 3 }), '@@ -1,4 +1,2 @@\n-\n a\n \n-\n')
  })
  it('settling is the default, since the context styles are what a diff is read in', () => {
    assert.deepEqual(diffLines(a, b), diffLines(a, b, { slide: true }))
    assert.notDeepEqual(diffLines(a, b), diffLines(a, b, { slide: false }))
  })
  it('leaves a run that was never free alone either way', () => {
    // Both blanks have to go, so there is nothing to settle.
    const x = splitRecords('\na\n\n'), y = splitRecords('a\n')
    assert.deepEqual(diffLines(x, y, { slide: false }), diffLines(x, y))
    assert.equal(formatNormal(x, y, diffLines(x, y)), '1d0\n< \n3d1\n< \n')
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

describe('sliding moves a run, it never resizes or breaks one', () => {
  it('keeps the size and the meaning, on thousands of change sets', () => {
    const next = random(20260915)
    for (let round = 0; round < 4000; round++) {
      // A change set built rather than searched for: some lines of `a` are
      // kept, the rest changed, and `b` is those kept lines with lines
      // inserted among them. Not the shortest change set, necessarily —
      // which is the point, since the slide may not assume one.
      const alphabet = 1 + Math.floor(next() * 3)
      const line = () => String.fromCodePoint(97 + Math.floor(next() * alphabet))
      const a = [], b = [], changedA = [], changedB = []
      for (let i = Math.floor(next() * 14); i > 0; i--) {
        while (next() < 0.3) { b.push(line()); changedB.push(1) }
        const kept = next() < 0.6
        a.push(line())
        changedA.push(kept ? 0 : 1)
        if (kept) { b.push(a.at(-1)); changedB.push(0) }
      }
      const flagsA = Uint8Array.from(changedA), flagsB = Uint8Array.from(changedB)
      const before = [flagsA.reduce((n, c) => n + c, 0), flagsB.reduce((n, c) => n + c, 0)]
      const idsA = a.map((c) => c.codePointAt(0)), idsB = b.map((c) => c.codePointAt(0))
      slideRuns(idsA, flagsA, flagsB)
      slideRuns(idsB, flagsB, flagsA)
      const replay = JSON.stringify([a.join(''), b.join('')])
      assert.deepEqual([flagsA.reduce((n, c) => n + c, 0), flagsB.reduce((n, c) => n + c, 0)], before, `round ${round}: ${replay}`)
      // What the change set says to do still turns `a` into `b`.
      const kept = (lines, changed) => lines.filter((_, i) => !changed[i]).join('')
      assert.equal(kept(a, flagsA), kept(b, flagsB), `round ${round}: ${replay}`)
    }
  })
})
