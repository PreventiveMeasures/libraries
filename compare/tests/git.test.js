import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareTrees, formatPatch } from '../compare.js'
import { CASES } from './cases.js'
import { RECORDINGS } from './fixtures/git.js'
import { entriesOf, numstatOf, rawOf, readNumstat, readRaw, withoutIndex } from './git.js'

// What git said of each pair in cases.js, as scripts/record-git.js recorded
// it, and compare held to it: the same files changed, renamed from the same
// files at the same scores, the same lines counted, and the same patch byte
// for byte but for git's index lines. These pairs have one shortest change
// set per file, so the hunks are pinned as much as the headers are.

describe('compare says what git says', () => {
  it('has a recording for every case', () => {
    assert.deepEqual(RECORDINGS.map(({ name }) => name), CASES.map(({ name }) => name))
  })

  for (const { name, options, old, new: fresh } of CASES) {
    const recorded = RECORDINGS.find((recording) => recording.name === name)
    describe(name, () => {
      // Renames by path are compare's own, which git does not look for.
      const changes = compareTrees(entriesOf(old), entriesOf(fresh), { renamesByPath: false, ...options })
      it('finds the same changes, renames and scores', () => assert.deepEqual(rawOf(changes), readRaw(recorded.raw)))
      it('counts the same lines', () => assert.deepEqual(numstatOf(changes), readNumstat(recorded.numstat)))
      it('writes the same patch', () => assert.equal(formatPatch(changes), withoutIndex(recorded.patch)))
    })
  }
})
