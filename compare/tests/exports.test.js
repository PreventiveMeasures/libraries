import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// What each entry point gives its callers, deptree's compare command and triage's
// Compare, which takes its server's answers as they are; what these are built on
// (the rename map, the checks on formatting and on blocks, the root found) stays inside.
describe('entry points', () => {
  it('export what their callers use alone', async () => {
    const names = async (entry) => Object.keys(await import(`../${entry}`)).toSorted()
    assert.deepEqual(await names('compare.js'), ['CompareError', 'compareTrees', 'formatPatch', 'hidesMixedWhitespace', 'layoutDir',
      'layoutPackageDirs', 'pairLines', 'renameParts', 'rootLabel', 'treeLayout', 'wordRanges'])
    assert.deepEqual(await names('names.js'), ['renamedDiff'])
    assert.deepEqual(await names('pretty.js'), ['format'])
  })
})
