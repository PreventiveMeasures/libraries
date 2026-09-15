import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitRecords } from '../src/compare.js'
import { formatContext, formatNormal, formatUnified } from '../src/format.js'
import { functionLine } from '../src/hunks.js'
import { diffLines, verifyChangeSet } from '../src/myers.js'
import { FILES, RECORDINGS } from './fixtures/gnu-diff.js'

// Held against GNU itself: for every recorded case, the change set GNU chose
// and the bytes GNU printed for it. Two claims come apart here — that the
// search picks the change set GNU picked, and that rendering one is GNU's
// rendering — so a failure says which half moved.
//
// Every recording is read back into the change set it prints, and every
// recording of a pair has to yield the same one — three readers, one for
// each style, checking each other as much as they check the code.

const lines = (text) => text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined)

const UNIFIED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

// A unified diff read back into the change set it prints: the run of `-`
// and the run of `+` at one point in a hunk are one block, positioned by the
// hunk header. An empty range names the line before it rather than the first
// line it covers, which is what `,0` marks.
function changeSetOfUnified(text) {
  const blocks = []
  let a = 0, b = 0, block = null
  const close = () => {
    if (block === null) return
    blocks.push(block)
    a = block.a1
    b = block.b1
    block = null
  }
  // The `---` and `+++` labels above the first hunk are not hunk lines.
  let started = false
  for (const line of lines(text)) {
    const header = UNIFIED_HUNK.exec(line)
    if (header) {
      close()
      started = true
      a = Number(header[1]) - (header[2] === '0' ? 0 : 1)
      b = Number(header[3]) - (header[4] === '0' ? 0 : 1)
    } else if (!started || line.startsWith('\\')) {
      // `\ No newline at end of file` belongs to the line above it.
    } else if (line.startsWith('-')) {
      if (block !== null && block.b1 > block.b0) close()
      block ??= { a0: a, a1: a, b0: b, b1: b }
      block.a1++
    } else if (line.startsWith('+')) {
      block ??= { a0: a, a1: a, b0: b, b1: b }
      block.b1++
    } else {
      close()
      a++
      b++
    }
  }
  close()
  return blocks
}

// A normal diff says its ranges outright: `3c3`, `5a6,7`, `8,9d9`. The side
// an append or a delete leaves empty names the line before it.
const NORMAL_COMMAND = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/u

function changeSetOfNormal(text) {
  const blocks = []
  for (const line of lines(text)) {
    const m = NORMAL_COMMAND.exec(line)
    if (!m) continue
    const [, aStart, aEnd, letter, bStart, bEnd] = m
    blocks.push({
      a0: letter === 'a' ? Number(aStart) : Number(aStart) - 1,
      a1: letter === 'a' ? Number(aStart) : Number(aEnd ?? aStart),
      b0: letter === 'd' ? Number(bStart) : Number(bStart) - 1,
      b1: letter === 'd' ? Number(bStart) : Number(bEnd ?? bStart),
    })
  }
  return blocks
}

const pairOf = (recording) => recording.names.join(' ')
const recordsOf = (recording) => recording.names.map((name) => splitRecords(FILES[name]))

// The context style does not spell its ranges out — each side lists its own
// lines, marked, and the sides are aligned by nothing but their order — so
// it is read the other way round: mark which lines of each file it says
// changed, then pair the runs the way a change set pairs them. A side with
// no changed lines of its own prints no lines at all, only its range, which
// is exactly the case where there is nothing to mark.
const CONTEXT_OLD = /^\*{3} (\d+)(?:,(\d+))? \*{4}$/u
const CONTEXT_NEW = /^--- (\d+)(?:,(\d+))? ----$/u

function changeSetOfContext(text, aLength, bLength) {
  const changed = { a: new Uint8Array(aLength), b: new Uint8Array(bLength) }
  let index = 0, side = null
  for (const line of lines(text)) {
    const old = CONTEXT_OLD.exec(line)
    const range = old ?? CONTEXT_NEW.exec(line)
    if (range) {
      side = changed[old ? 'a' : 'b']
      // An empty range names the line before it and is followed by no lines
      // at all, so reading it as the first line it covers marks nothing.
      index = Number(range[1]) - 1
      continue
    }
    // The label lines above the first hunk, the fence between hunks, and
    // `\ No newline at end of file`, which belongs to the line above it.
    if (side === null || !/^[-+! ] /u.test(line)) continue
    if (line[0] !== ' ') side[index] = 1
    index++
  }
  return pairRuns(changed.a, changed.b)
}

// Runs of changed lines, paired up — the same walk src/myers.js makes over
// the arrays its search fills in. Written out again rather than reached for,
// deliberately: a walk that agreed with itself would prove nothing.
function pairRuns(changedA, changedB) {
  const blocks = []
  let i = 0, j = 0
  while (i < changedA.length || j < changedB.length) {
    if (i < changedA.length && j < changedB.length && !changedA[i] && !changedB[j]) { i++; j++; continue }
    const a0 = i, b0 = j
    while (i < changedA.length && changedA[i]) i++
    while (j < changedB.length && changedB[j]) j++
    blocks.push({ a0, a1: i, b0, b1: j })
  }
  return blocks
}

// GNU's change set per pair. A pair is usually recorded in more than one
// style, and the readers have to agree about it: a disagreement means one of
// the three is wrong, and every assertion built on it worth nothing.
const gnuChangeSets = new Map()
const disagreements = []
for (const recording of RECORDINGS) {
  const [a, b] = recordsOf(recording)
  const blocks = recording.style === 'unified' ? changeSetOfUnified(recording.stdout)
    : recording.style === 'normal' ? changeSetOfNormal(recording.stdout)
      : changeSetOfContext(recording.stdout, a.length, b.length)
  const seen = gnuChangeSets.get(pairOf(recording))
  if (seen && JSON.stringify(seen.blocks) !== JSON.stringify(blocks)) disagreements.push(`${recording.command} and ${seen.command}`)
  gnuChangeSets.set(pairOf(recording), { blocks, command: recording.command })
}

describe('the corpus is a corpus', () => {
  it('holds a fair number of cases in every style', () => {
    const counted = (style) => RECORDINGS.filter((recording) => recording.style === style).length
    for (const style of ['normal', 'unified', 'context']) assert.ok(counted(style) >= 10, `${style}: ${counted(style)} cases`)
    assert.ok(RECORDINGS.some((recording) => recording.showFunction), 'no -p case, so no function line is checked')
  })
  it('pins a change set for every pair it records', () => {
    for (const recording of RECORDINGS) assert.ok(gnuChangeSets.has(pairOf(recording)), `${recording.command}: no change set was read back`)
  })
  it('reads the same change set out of every style that records a pair', () => {
    assert.deepEqual(disagreements, [])
  })
})

describe('the search picks the change set GNU picked', () => {
  for (const [pair, { blocks, command }] of gnuChangeSets) {
    it(pair, () => {
      const [a, b] = pair.split(' ').map((name) => splitRecords(FILES[name]))
      // The reader above is checked here too: a change set it misread would
      // not reconstruct the second file.
      verifyChangeSet(a, b, blocks)
      assert.deepEqual(diffLines(a, b), blocks, `recorded by ${command}`)
      assert.deepEqual(diffLines(a, b, { minimal: true }), blocks, `recorded by ${command}`)
    })
  }
})

describe('rendering GNU\'s change set is GNU\'s rendering, byte for byte', () => {
  for (const recording of RECORDINGS) {
    it(recording.command, () => {
      const [a, b] = recordsOf(recording)
      const { blocks } = gnuChangeSets.get(pairOf(recording))
      if (recording.style === 'normal') {
        assert.equal(formatNormal(a, b, blocks), recording.stdout)
        return
      }
      // The two label lines are the caller's to build; the rest is the
      // formatter's, so the recording's own header goes back in.
      const header = recording.stdout.split('\n').slice(0, 2).join('\n') + '\n'
      const fn = recording.showFunction ? (index) => functionLine(a, index) : null
      const format = recording.style === 'unified' ? formatUnified : formatContext
      assert.equal(format(a, b, blocks, { context: recording.context, header, fn }), recording.stdout)
    })
  }
})
