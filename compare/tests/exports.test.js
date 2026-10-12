import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// What each entry point gives its callers, deptree's compare command and triage's
// Compare; what these are built on (the rename map, the check on formatting, the
// root found, a change's lines alone) stays inside.
describe('entry points', () => {
  it('export what their callers use alone', async () => {
    const names = async (entry) => Object.keys(await import(`../${entry}`)).toSorted()
    assert.deepEqual(await names('compare.js'), ['CompareError', 'blocksHold', 'compareTrees', 'formatPatch', 'hidesMixedWhitespace', 'layoutDir',
      'layoutPackageDirs', 'pairLines', 'renameParts', 'renamedAlone', 'rootLabel', 'treeLayout', 'wordRanges'])
    assert.deepEqual(await names('names.js'), ['renamedDiff'])
    assert.deepEqual(await names('pretty.js'), ['formatChecked'])
  })
})
