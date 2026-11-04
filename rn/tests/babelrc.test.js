import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { babelrcFinder } from '../src/babelrc.js'
import { writeTree } from './fixtures.js'

describe('babelrcFinder, as Babel looks for a .babelrc of a file', () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'index.js': '',
    'lib/deep/a.js': '',
    // Of each name Babel takes, and of what it may take one day.
    'src/.babelrc.js': 'module.exports = {}\n',
    'src/deep/b.js': '',
    'ts/.babelrc.mts': '',
    'ts/c.ts': '',
    'ignored/.babelignore': '*\n',
    'ignored/d.js': '',
    // A package of its own, beneath its parent's .babelrc, which it doesn't take.
    'src/inner/package.json': { name: 'inner' },
    'src/inner/e.js': '',
    'keyed/package.json': { name: 'keyed', babel: { plugins: [] } },
    'keyed/f.js': '',
    'broken/package.json': '{',
    'broken/g.js': '',
    // Short of a node_modules, where Babel stops: not its .babelrc.
    'node_modules/pkg/package.json': { name: 'pkg' },
    'node_modules/pkg/lib/h.js': '',
    'node_modules/i.js': '',
    'node_modules/.babelrc': {},
    'node_modules/loose/j.js': '',
  })
  after(cleanup)
  const finds = babelrcFinder()
  const at = (path) => finds(join(root, path))

  it("finds none where the file's package has none", () => {
    assert.deepEqual(['index.js', 'lib/deep/a.js', 'src/inner/e.js', 'node_modules/pkg/lib/h.js', 'node_modules/i.js', 'node_modules/loose/j.js'].map(at), [false, false, false, false, false, false])
  })

  it('finds a .babelrc of any name, or a .babelignore, in a directory from the file up to its package', () => {
    assert.deepEqual(['src/deep/b.js', 'ts/c.ts', 'ignored/d.js'].map(at), [true, true, true])
  })

  it("finds a package.json's babel key, and one Babel can't read, which it fails on", () => {
    assert.deepEqual(['keyed/f.js', 'broken/g.js'].map(at), [true, true])
  })
})
