import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareTrees, formatPatch } from '../compare.js'
import { CASES } from './cases.js'
import { diffFlags, entriesOf, gitVersion, numstatOf, rawOf, readNumstat, readRaw, repository, withoutIndex } from './git.js'
import { treePair } from './random.js'

// The recordings say what git said once, of pairs made to say one thing
// each; this asks the git on the machine, when it is 2.44 or later, about
// pairs made at random, and has it apply every patch compare writes.
// Skipped without one -- git.test.js carries the package everywhere else.
//
// Where a file's lines have more than one shortest change set, git's search
// and diff's may settle on different ones, and the hunks differ while
// meaning the same; so a random pair is held to git's raw output, its
// counts, every line of its patch that is not a hunk's, and to the patch
// carrying the old tree to the new one -- not to git's hunks.

const version = gitVersion()
const recent = version !== null && (version[0] > 2 || (version[0] === 2 && version[1] >= 44))

const SEEDS = 40
// Every line of a patch but its hunks'.
const HEADER = /^(?:diff --git |old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to |--- |\+\+\+ |Binary files )/u
const headers = (patch) => patch.split('\n').filter((line) => HEADER.test(line))

// A patch with no binary file in it, which git apply can carry out.
const appliable = (patch) => !patch.includes('\nBinary files ')

describe('git agrees', { skip: recent ? false : 'git 2.44 or later is not on the PATH' }, () => {
  for (const { name, options, old, new: fresh } of CASES) {
    it(`applies the patch for: ${name}`, (t) => {
      const repo = repository(old, fresh)
      t.after(repo.close)
      const patch = formatPatch(compareTrees(entriesOf(old), entriesOf(fresh), { renamesByPath: false, ...options }))
      if (appliable(patch)) assert.ok(repo.applies(patch))
    })
  }

  for (let seed = 1; seed <= SEEDS; seed++) {
    // Some under a stricter threshold, some under a limit that skips the scores.
    const options = seed % 5 === 0 ? { renames: 90 } : seed % 7 === 0 ? { renameLimit: 1 } : {}
    it(`on random trees, seed ${seed}${options.renames ? ' at 90%' : options.renameLimit ? ' with a rename limit of 1' : ''}`, (t) => {
      const pair = treePair(seed)
      const repo = repository(pair.old, pair.new)
      t.after(repo.close)
      const flags = diffFlags(options)
      const changes = compareTrees(entriesOf(pair.old), entriesOf(pair.new), { renamesByPath: false, ...options })
      assert.deepEqual(rawOf(changes), readRaw(repo.diff([...flags, '--raw', '-z'])))
      assert.deepEqual(numstatOf(changes), readNumstat(repo.diff([...flags, '--numstat', '-z'])))
      const patch = formatPatch(changes)
      assert.deepEqual(headers(patch), headers(withoutIndex(repo.diff(flags))))
      if (appliable(patch)) assert.ok(repo.applies(patch), 'git apply carries the old tree to the new one')
      // Renames by path are no git's, but a patch naming them is one git applies.
      const byPath = formatPatch(compareTrees(entriesOf(pair.old), entriesOf(pair.new), options))
      if (appliable(byPath)) assert.ok(repo.applies(byPath), 'and with renames by path')
    })
  }
})
