import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pack, unpack } from '@preventive/archive/tar.js'
import { createVfs } from '@preventive/vfs'
import { CompareError, compareTrees } from '../compare.js'

// How a tree is read: from the entries tar and a Vfs give, as they give them,
// into the files and links git would hold; and what is refused.

const utf8 = (text) => new TextEncoder().encode(text)
const summary = (changes) => changes.map(({ status, old, new: fresh }) => [status, old?.path ?? null, fresh?.path ?? null])

describe('a tree is read from entries as tar and a Vfs give them', () => {
  it("takes a Vfs's entries as they are, its root and directories among them", () => {
    const before = createVfs({ 'a/x.txt': 'one\n', 'a/link': { type: 'symlink', target: 'x.txt' }, 'empty': { type: 'directory' } })
    const after = createVfs({ 'a/x.txt': 'one\ntwo\n', 'a/link': { type: 'symlink', target: 'y.txt' }, 'more': { type: 'directory' } })
    assert.deepEqual(summary(compareTrees(before.entries(), after.entries())), [['modified', 'a/link', 'a/link'], ['modified', 'a/x.txt', 'a/x.txt']])
  })

  it("takes a tar's entries as unpack gives them, `./` and all", () => {
    const tar = (entries) => unpack(pack(entries))
    const before = tar([{ name: '.', type: 'directory' }, { name: 'pkg/', type: 'directory' }, { name: 'pkg/index.js', data: utf8('a\n') }])
    const after = tar([{ name: './pkg/main.js', data: utf8('a\n'), mode: 0o755 }])
    const [change] = compareTrees(before, after)
    assert.deepEqual([change.status, change.old.path, change.new.path, change.new.mode], ['renamed', 'pkg/index.js', 'pkg/main.js', 0o755])
  })

  it('reads text as UTF-8 and a file with no mode as 644, and keeps bytes given as they are', () => {
    const bytes = utf8('\u{E9}\n')
    const [change] = compareTrees([], [{ name: 'b', data: '\u{E9}\n', type: 'contiguous-file' }])
    assert.deepEqual(change.new, { path: 'b', type: 'file', mode: 0o644, data: bytes })
    assert.equal(compareTrees([], [{ name: 'a', data: bytes }])[0].new.data, bytes, 'the same bytes, not a copy')
  })

  it('takes a directory to add nothing, and an empty one to be no change', () => {
    assert.deepEqual(compareTrees([{ name: 'd', type: 'directory' }], [{ name: 'e', type: 'directory' }, { name: 'e/f', type: 'directory' }]), [])
  })

  it('reads a hard link as a copy of what it names, through any chain of them', () => {
    const tree = [
      { name: 'x', data: 'x\n', mode: 0o755 },
      { name: 'l', type: 'symlink', linkname: 'x' },
      { name: 'h1', type: 'hardlink', linkname: 'x', mode: 0o644 },
      { name: 'h2', type: 'hardlink', linkname: 'h1' },
      { name: 'hl', type: 'hardlink', linkname: 'l' },
    ]
    const added = compareTrees([], tree, { renames: false }).map((change) => change.new)
    assert.deepEqual(added.map(({ path, type, mode, target }) => [path, type, mode, target]), [
      ['h1', 'file', 0o755, undefined], ['h2', 'file', 0o755, undefined], ['hl', 'symlink', undefined, 'x'], ['l', 'symlink', undefined, 'x'], ['x', 'file', 0o755, undefined],
    ])
  })

  it('reads entries from any iterable, once', () => {
    function* entries() {
      yield { name: 'a', data: 'a\n' }
    }
    assert.deepEqual(summary(compareTrees(entries(), [])), [['deleted', 'a', null]])
  })
})

describe('a tree that does not hold together is refused', () => {
  const refuses = (entries, detail, path, tree = 'old') => {
    assert.throws(() => compareTrees(entries, []), (error) => {
      assert.ok(error instanceof CompareError, error.message)
      assert.match(error.message, detail)
      assert.equal(error.path, path)
      assert.equal(error.tree, tree)
      return true
    })
  }

  it('names the path and the tree', () => {
    assert.throws(() => compareTrees([], [{ name: 'a' }, { name: 'a' }]), { name: 'CompareError', message: 'a name is given twice: "a" in the new tree', path: 'a', tree: 'new' })
  })

  it('takes a name once, whatever it names', () => {
    refuses([{ name: 'a' }, { name: 'a' }], /given twice/u, 'a')
    refuses([{ name: 'a', type: 'directory' }, { name: 'a', type: 'directory' }], /given twice/u, 'a')
    refuses([{ name: 'a', type: 'directory' }, { name: 'a' }], /given twice/u, 'a')
  })

  it('takes a plain relative path alone', () => {
    for (const name of ['', '/a', 'a/', 'a//b', './a', 'a/./b', 'a/../b', '..', '.']) refuses([{ name }], /relative path/u, name)
  })

  it('takes nothing under a file or a link', () => {
    refuses([{ name: 'a' }, { name: 'a/b' }], /under a file/u, 'a/b')
    refuses([{ name: 'a/b/c' }, { name: 'a', type: 'symlink', linkname: '/etc' }], /under a link/u, 'a/b/c')
    refuses([{ name: 'a' }, { name: 'a/b', type: 'directory' }], /under a file/u, 'a/b')
  })

  it('takes a hard link to a file or a link of the tree alone', () => {
    refuses([{ name: 'h', type: 'hardlink', linkname: 'nothing' }], /must name a file or a link/u, 'h')
    refuses([{ name: 'd', type: 'directory' }, { name: 'h', type: 'hardlink', linkname: 'd' }], /must name a file or a link/u, 'h')
    refuses([{ name: 'h1', type: 'hardlink', linkname: 'h2' }, { name: 'h2', type: 'hardlink', linkname: 'h1' }], /leads back to itself/u, 'h1')
  })

  it('takes a link to name its target', () => {
    refuses([{ name: 'l', type: 'symlink' }], /must name its target/u, 'l')
    refuses([{ name: 'l', type: 'symlink', linkname: '' }], /must name its target/u, 'l')
    refuses([{ name: 'h', type: 'hardlink' }], /must name its target/u, 'h')
  })

  it('takes a name and a link target with UTF-8 to them alone', () => {
    refuses([{ name: 'a\u{D800}' }], /well-formed Unicode/u, 'a\u{D800}')
    refuses([{ name: 'l', type: 'symlink', linkname: '\u{DC00}x' }], /link target must be well-formed/u, 'l')
  })

  it('has nothing for a fifo or a device, which git cannot hold', () => {
    for (const type of ['fifo', 'character-device', 'block-device']) refuses([{ name: 'dev', type }], new RegExp(`a ${type} is neither`, 'u'), 'dev')
  })
})

describe('an entry of the wrong shape is a TypeError or a RangeError', () => {
  it('names what is wrong', () => {
    assert.throws(() => compareTrees([null], []), TypeError)
    assert.throws(() => compareTrees(['a'], []), TypeError)
    assert.throws(() => compareTrees([{ name: 1 }], []), TypeError)
    assert.throws(() => compareTrees([{ name: 'a', type: 'pipe' }], []), TypeError)
    assert.throws(() => compareTrees([{ name: 'a', type: 1 }], []), TypeError)
    assert.throws(() => compareTrees([{ name: 'a', data: 1 }], []), TypeError)
    assert.throws(() => compareTrees([{ name: 'a', data: [1] }], []), TypeError)
    assert.throws(() => compareTrees([{ name: 'a', data: 'x\u{D800}' }], []), TypeError, 'text with no UTF-8')
    for (const mode of [-1, 0o10000, 1.5, '644', null]) assert.throws(() => compareTrees([{ name: 'a', mode }], []), RangeError, String(mode))
  })

  it('throws before anything is compared, whichever tree it is in', () => {
    assert.throws(() => compareTrees([{ name: 'a' }], [{ name: 'a', mode: -1 }]), RangeError)
  })
})
