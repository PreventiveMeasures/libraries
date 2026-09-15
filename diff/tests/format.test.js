import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitRecords } from '../src/compare.js'
import { FormatError, formatContext, formatNormal, formatUnified } from '../src/format.js'
import { functionLine } from '../src/hunks.js'
import { diffLines, verifyChangeSet } from '../src/myers.js'
import { parseDiff } from '../src/parse.js'
import { FILES, RECORDINGS } from './fixtures/gnu-diff.js'

// Held against GNU itself: for every recorded case, the change set GNU chose
// and the bytes GNU printed for it. Two claims come apart here — that the
// search picks the change set GNU picked, and that rendering one is GNU's
// rendering — so a failure says which half moved.
//
// The recordings are read back with the package's own parser, which is the
// other half of the same claim: if writing and reading disagree, the pair
// that a style recorded twice will not read back the same way twice.

const pairOf = (recording) => recording.names.join(' ')
const recordsOf = (recording) => recording.names.map((name) => splitRecords(FILES[name]))
const bare = (blocks) => blocks.map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }))

// GNU's change set per pair. A pair is usually recorded in more than one
// style, and every style has to read back the same: a disagreement means the
// parser is wrong about one of them, and every assertion built on it worth
// nothing.
const gnuChangeSets = new Map()
const disagreements = []
for (const recording of RECORDINGS) {
  const blocks = bare(parseDiff(recording.stdout)[0].blocks)
  const seen = gnuChangeSets.get(pairOf(recording))
  if (seen && JSON.stringify(seen.blocks) !== JSON.stringify(blocks)) disagreements.push(`${recording.command} and ${seen.command}`)
  gnuChangeSets.set(pairOf(recording), { blocks, command: recording.command })
}

// Every rendering below runs through that check on its way out, so the
// corpus is checking it as much as it is checking the bytes. It cannot be
// tripped from outside: with a correct formatter, any change set that can be
// rendered at all renders to something that reads back as itself. Breaking a
// formatter is what trips it — an off-by-one in a range line reads back as
// `block 1 reads back somewhere else`, and a context line taken from the
// wrong place as `a kept line is not the line it stands for`.
describe('what is printed is read back before it is returned', () => {
  it('has an error of its own to throw', () => {
    assert.ok(new FormatError('x') instanceof Error)
    assert.equal(new FormatError('x').name, 'FormatError')
  })
  it('passes an empty change set through, having nothing to print', () => {
    const a = splitRecords('a\n')
    assert.equal(formatNormal(a, a, []), '')
    assert.equal(formatUnified(a, a, [], { context: 3, header: '--- x\n+++ y\n', fn: null }), '--- x\n+++ y\n')
  })
})

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
      // The parser is checked here too: a change set it misread would not
      // reconstruct the second file.
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
