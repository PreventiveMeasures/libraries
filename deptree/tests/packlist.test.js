import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { packDirectory } from '../src/pnpm/packlist.js'

// The files of a directory npm-packlist's built-in rules keep, as pnpm 10
// and pnpm 11 install them from a `file:` dependency.
describe('packDirectory', () => {
  const manifest = { name: 'foo', version: '1.0.0', main: 'index.js', bin: { foo: 'cli.js' } }
  const pack = (files, major, fields = {}) => {
    const all = { 'package.json': JSON.stringify({ ...manifest, ...fields }), ...files }
    const vfs = createVfs(Object.fromEntries(Object.entries(all).map(([path, text]) => [`d/${path}`, text])))
    return [...packDirectory(vfs, 'd', { ...manifest, ...fields }, major, 'x').keys()].sort()
  }

  it('leaves out what npm-packlist leaves out by its built-in rules', () => {
    const files = {
      'index.js': '', 'cli.js': '', '.hidden': '', 'README.md': '', 'lib/x.js': '',
      '.git/HEAD': '', 'lib/CVS/Root': '', 'lib/cvs2/y': '', '.npmrc': '', 'lib/.DS_Store': '', 'NPM-DEBUG.LOG': '',
      '._foo': '', 'lib/.x.swp': '', 'X.ORIG': '', '.lock-wscript': '', '.wafpickle-7': '', 'build/config.gypi': '',
      'build/other.gypi': '', 'archived-packages/x': '', 'package-lock.json': '', 'Yarn.Lock': '', 'lib/yarn.lock': '', 'star*.js': '',
    }
    const kept = ['.hidden', 'README.md', 'build/other.gypi', 'cli.js', 'index.js', 'lib/cvs2/y', 'lib/x.js', 'lib/yarn.lock', 'package.json']
    assert.deepEqual(pack(files, 10), kept)
    assert.deepEqual(pack(files, 11), kept)
  })

  it('leaves out bun.lockb for pnpm 11 alone, and the rules at the top in every directory', () => {
    const files = { 'bun.lockb': '', 'lib/.lock-wscript': '', 'lib/.wafpickle-1': '', 'lib/build/config.gypi': '', 'lib/archived-packages/y': '' }
    assert.deepEqual(pack(files, 10), ['bun.lockb', 'lib/.lock-wscript', 'lib/.wafpickle-1', 'lib/archived-packages/y', 'lib/build/config.gypi', 'package.json'])
    assert.deepEqual(pack(files, 11), ['package.json'])
  })

  it('takes an empty list of bundled dependencies, which bundles none', () => {
    for (const fields of [{ bundleDependencies: [] }, { bundledDependencies: [] }, { bundleDependencies: [], bundledDependencies: [] }]) {
      assert.deepEqual(pack({ 'index.js': '' }, 10, fields), ['index.js', 'package.json'], JSON.stringify(fields))
    }
  })

  const refused = [
    ['a .npmignore', { '.npmignore': 'x\n' }, {}, /\.npmignore's rules/u],
    ['a .gitignore anywhere', { 'lib/.gitignore': 'x\n' }, {}, /\.gitignore's rules/u],
    ['a package.json with files', {}, { files: ['index.js'] }, /has `files`/u],
    ['bundled dependencies', {}, { bundleDependencies: ['a'] }, /bundled dependencies is not supported/u],
    ['all dependencies bundled', {}, { bundledDependencies: true }, /bundled dependencies is not supported/u],
    ['bundled dependencies beside an empty list', {}, { bundleDependencies: [], bundledDependencies: ['a'] }, /bundled dependencies is not supported/u],
    ['a readme the rules would leave out', { 'lib/README.orig': '' }, {}, /turns on rules of npm-packlist not followed here/u],
    ['a bin the rules would leave out', { 'npm-debug.log': '' }, { bin: { foo: 'npm-debug.log' } }, /turns on rules of npm-packlist not followed here/u],
    ['node_modules but for its case', { 'Node_Modules/x': '' }, {}, /node_modules but for its case/u],
  ]
  for (const [what, files, fields, pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => pack(files, 11, fields), (error) => error.name === 'DeptreeError' && pattern.test(error.message)))
  }

  it('refuses a link, and a mode linking a bin would change otherwise', () => {
    const vfs = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '' })
    vfs.symlink('a.js', '/d/b.js')
    assert.throws(() => packDirectory(vfs, 'd', manifest, 10, 'x'), /a link in a directory pnpm installs a copy of is not supported/u)
    const odd = createVfs({ 'd/package.json': JSON.stringify(manifest), 'd/a.js': '' })
    odd.chmod('/d/a.js', 0o600)
    assert.throws(() => packDirectory(odd, 'd', manifest, 10, 'x'), /its mode, 600, is not 644 or 755/u)
  })
})
