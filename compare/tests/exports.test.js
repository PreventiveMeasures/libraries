import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

// What each entry point gives its callers, deptree's compare command and triage's
// Compare, which takes its server's answers as they are; what these are built on
// (the rename map, the checks on formatting and on blocks, the root found) stays inside.
describe('entry points', () => {
  it('export what their callers use alone', async () => {
    const names = async (entry) => Object.keys(await import(`../${entry}`)).toSorted()
    assert.deepEqual(await names('compare.js'), ['CompareError', 'compareTrees', 'formatPatch', 'hidesMixedWhitespace', 'layoutDir',
      'layoutPackageDirs', 'pairLines', 'proveTypeOnly', 'renameParts', 'rootLabel', 'treeLayout', 'wordRanges'])
    assert.deepEqual(await names('names.js'), ['renamedDiff', 'renamedDiffs'])
    assert.deepEqual(await names('pretty.js'), ['format'])
    assert.deepEqual(await names('view.js'), ['hidesMixedWhitespace', 'layoutDir', 'pairLines', 'renameParts', 'rootLabel', 'wordRanges'])
  })

  // A view given its files paired loads none of what pairs them: compareTrees,
  // its renames and the root found between two trees.
  it('view.js reaches none of the pairing', () => {
    const reached = new Set()
    const visit = (url) => {
      if (reached.has(url.href)) return
      reached.add(url.href)
      for (const [, spec] of readFileSync(url, 'utf8').matchAll(/^(?:import|export)\b[^'"]*?from\s*'([.#][^']+)'/gmu)) {
        // A package import (`#types`) is told by its name, as loading one may load anything.
        if (spec.startsWith('#')) reached.add(new URL(spec, new URL('../', import.meta.url)).href)
        else visit(new URL(spec, url))
      }
    }
    visit(new URL('../view.js', import.meta.url))
    const files = [...reached].map((href) => href.slice(new URL('../', import.meta.url).href.length)).toSorted()
    assert.deepEqual(files, ['src/blocks.js', 'src/pairs.js', 'src/paths.js', 'src/root.js', 'src/script.js', 'src/text.js', 'src/whitespace.js', 'src/words.js', 'view.js'])
  })
})
