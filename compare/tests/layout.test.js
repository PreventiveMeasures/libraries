import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { layoutDir, layoutPackageDirs, pathRenames, renameParts, rootLabel, treeLayout } from '../compare.js'
import { detectRoot, rootDir } from '../src/layout.js'

describe('pathRenames', () => {
  // The package a path is in: the one after its last node_modules, or own source.
  const pkgOf = (path) => /^(?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+/u.exec(path)?.[0] ?? '__own__'
  const renames = (removed, added) => Object.fromEntries(pathRenames(removed, added, pkgOf))

  it('pairs an extension change, a directory swapped, and both', () => {
    assert.deepEqual(renames(['src/a.js'], ['src/a.ts']), { 'src/a.js': 'src/a.ts' })
    assert.deepEqual(renames(['src/a.js'], ['lib/a.js']), { 'src/a.js': 'lib/a.js' })
    assert.deepEqual(renames(['src/a.ts'], ['lib/a.js']), { 'src/a.ts': 'lib/a.js' })
    assert.deepEqual(renames(['x/src/y/a.css'], ['x/lib/y/a.scss']), { 'x/src/y/a.css': 'x/lib/y/a.scss' }, 'at any depth')
    assert.deepEqual(renames(['node_modules/a/src/x.ts'], ['node_modules/a/lib/x.js']), { 'node_modules/a/src/x.ts': 'node_modules/a/lib/x.js' })
  })

  it('pairs only a clear rename', () => {
    assert.deepEqual(renames(['src/a.js'], ['lib/a.js', 'src/a.ts']), {}, 'two files it could be')
    assert.deepEqual(renames(['src/a.js', 'lib/a.ts'], ['lib/a.js']), {}, 'two files it could be from')
    assert.deepEqual(renames(['src/a.js', 'src/a.css'], ['lib/a.js', 'lib/a.css']), { 'src/a.js': 'lib/a.js', 'src/a.css': 'lib/a.css' }, 'a script and a style of one name move apart')
    assert.deepEqual(renames(['src/a.css'], ['src/a.js']), {}, 'a style does not become a script')
    assert.deepEqual(renames(['src/a.json'], ['src/a.yaml']), {}, 'other files keep their extension')
    assert.deepEqual(renames(['src/a.js'], ['src/b.js']), {}, 'nor change their name')
    assert.deepEqual(renames(['src/x/a.js'], ['lib/y/a.js']), {}, 'one directory swaps, not two')
    assert.deepEqual(renames(['src/a.js'], ['src/lib/a.js']), {}, 'nor moves deeper')
  })

  it('stays within a group, past its last node_modules', () => {
    assert.deepEqual(renames(['node_modules/left-pad/index.js'], ['node_modules/zod/index.js']), {})
    assert.deepEqual(renames(['a/node_modules/b/x.js'], ['c/node_modules/b/x.js']), {})
    assert.deepEqual(renames(['node_modules/a/index.js'], ['src/index.js']), {})
    assert.deepEqual(Object.fromEntries(pathRenames(['node_modules/a/index.js', 'node_modules/b/x.js'], ['src/index.js', 'node_modules/c/x.js'])), {}, 'no group given, still not past a package')
    const groups = new Map([['a/x.js', 1], ['b/x.js', '1'], ['c/y.js', {}], ['d/y.js', {}]])
    assert.deepEqual(Object.fromEntries(pathRenames(['a/x.js', 'c/y.js'], ['b/x.js', 'd/y.js'], (path) => groups.get(path))), {}, 'groups told apart as Map keys are')
  })
})

describe('renameParts', () => {
  const label = (from, to, options) => {
    const { head, from: before, to: after, tail } = renameParts(from, to, options)
    return `${head}{${before} -> ${after}}${tail}`
  }

  it('writes a rename the way git diff --stat does', () => {
    assert.equal(label('src/a.js', 'src/a.ts'), 'src/a{.js -> .ts}', 'down to the extension when that is all')
    assert.equal(label('src/a.js', 'src/a.ts', { extension: false }), 'src/{a.js -> a.ts}', 'or whole names')
    assert.equal(label('a.css', 'a.scss'), 'a{.css -> .scss}')
    assert.equal(label('src/a.test.js', 'src/a.test.ts'), 'src/a.test{.js -> .ts}')
    assert.equal(label('src/a.js', 'lib/a.js'), '{src -> lib}/a.js')
    assert.equal(label('x/src/y/a.js', 'x/lib/y/a.js'), 'x/{src -> lib}/y/a.js')
    assert.equal(label('node_modules/a/src/x.ts', 'node_modules/a/lib/x.js'), 'node_modules/a/{src/x.ts -> lib/x.js}')
  })
})

describe('trees taken from different roots', () => {
  it('lays out one tree as if under the directory the other holds it in, either way round', () => {
    const flat = ['dir/file/a.js', 'dir/file/b.js'], nested = ['src/dir/file/a.js', 'src/dir/file/b.js', '__prelude__']
    assert.deepEqual(detectRoot(flat, nested), { base: '', other: 'src/' })
    assert.deepEqual([...treeLayout(flat, nested).paths], [['dir/file/a.js', 'src/dir/file/a.js'], ['dir/file/b.js', 'src/dir/file/b.js']])
    const back = treeLayout(nested, flat)
    assert.deepEqual(back.root, { base: 'src/', other: '' })
    assert.equal(back.paths.get('__prelude__'), '../__prelude__', 'a file outside the root above it')
    assert.deepEqual(detectRoot(['src/a.js', 'src/b.js', 'x.js', 'y.js', 'z.js'], ['a.js', 'b.js']), { base: 'src/', other: '' }, 'half the side without it, however many files the other holds')
  })

  it('pairs a file both keep at their own root as it is, and gives every old file a path of its own', () => {
    assert.equal(treeLayout(['package.json', 'dir/a.js', 'dir/b.js'], ['package.json', 'src/dir/a.js', 'src/dir/b.js']).paths.get('package.json'), 'package.json')
    const layout = treeLayout(['src/a.js', 'src/b.js', 'a.js', '../a.js'], ['a.js', 'b.js', '../a.js'])
    assert.deepEqual(layout.root, { base: 'src/', other: '' })
    assert.equal(new Set(layout.paths.values()).size, 4)
    assert.equal(layout.paths.get('a.js'), '../../a.js', 'a `../` further out than the root could place it')
  })

  it('takes no root where two would pair as many, or only a few files would move', () => {
    const one = ['a.js', 'b.js', 'x/c.js', 'x/d.js'], two = ['x/a.js', 'x/b.js', 'c.js', 'd.js']
    assert.equal(detectRoot(one, two), null, 'x/ either way')
    assert.equal(detectRoot(two, one), null)
    assert.equal(detectRoot(['a.js', 'b.js'], ['x/a.js', 'x/b.js', 'y/a.js', 'y/b.js']), null, 'two directories holding as many')
    assert.equal(detectRoot(['a.js', 'b.js', 'lib/a.js'], ['a.js', 'b.js', 'lib/a.js']), null)
    assert.equal(detectRoot(['a.js', 'b.js', 'c.js', 'd.js'], ['src/a.js', 'x.js', 'y.js', 'z.js']), null, 'one file of four')
    assert.equal(detectRoot(['own/src/a.js', 'own/keep.js'], ['own/lib/a.ts', 'own/keep.js']), null)
  })

  it('moves directories and package directories with the root', () => {
    assert.equal(rootDir(null, 'crates/foo'), 'crates/foo')
    assert.equal(rootDir({ base: '', other: 'src/' }, 'crates/foo'), 'src/crates/foo')
    assert.equal(rootDir({ base: '', other: 'src/' }, '.'), '.')
    assert.equal(rootDir({ base: 'src/', other: '' }, 'src/crates/foo'), 'crates/foo')
    assert.equal(rootDir({ base: 'src/', other: '' }, 'src'), '.')
    assert.equal(rootDir({ base: 'src/', other: '' }, 'tools'), '../tools', 'outside the root, as its files read')
    assert.equal(rootDir({ base: 'a/b/', other: '' }, 'tools'), '../../tools')
    const layout = treeLayout(['src/a.js', 'src/b.js', 'tools/crate/lib.rs'], ['a.js', 'b.js', '../tools/crate/lib.rs'])
    assert.equal(layout.paths.get('tools/crate/lib.rs'), '../../tools/crate/lib.rs')
    assert.equal(layoutDir(layout, 'tools/crate', ['lib.rs']), '../../tools/crate')
    assert.equal(layoutDir(layout, 'tools/other', ['x.rs']), '../tools/other', 'a module none of whose files are laid out moves with the root')
    assert.equal(layoutDir(layout, '.', ['src/a.js']), '.')
    assert.equal(layoutPackageDirs(new Map([['tools/crate/lib.rs', 'tools/crate']]), null, layout).get('../../tools/crate/lib.rs'), '../../tools/crate')
    assert.equal(layoutPackageDirs(null, null, { root: null, paths: new Map() }), null)
    assert.deepEqual([...layoutPackageDirs(new Map([['src/a.js', 'src'], ['src/b/c.js', 'src/b'], ['tools/t.js', 'tools']]), new Map([['x.js', '.']]),
      { root: { base: 'src/', other: '' }, paths: new Map([['src/a.js', 'a.js'], ['src/b/c.js', 'b/c.js'], ['tools/t.js', '../tools/t.js']]) })],
    [['a.js', '.'], ['b/c.js', 'b'], ['../tools/t.js', '../tools'], ['x.js', '.']], 'the root itself reads as `.`, the new side\'s kept')
  })

  it('labels a directory with where the root puts it on each side', () => {
    assert.deepEqual(rootLabel(null, 'dir/'), { prefix: 'dir/', from: null, to: null })
    assert.deepEqual(rootLabel({ base: '', other: 'src/' }, 'src/dir/'), { prefix: 'src/dir/', from: './dir/', to: './src/dir/' })
    assert.deepEqual(rootLabel({ base: '', other: 'src/' }, 'lib/'), { prefix: '', from: './', to: './src/' }, 'a prefix the root does not lead is dropped')
  })
})
