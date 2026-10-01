import assert from 'node:assert/strict'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { gitTreeOfTarball } from '../src/tree.js'
import { COMMIT_TGZ, SUBMODULE, SUBMODULE_COMMIT, SUBMODULE_TGZ, TREE, TREE_TGZ } from './tree-fixtures.js'

// The tar inside, with `find` written over by `replace` at `offset` from
// where it starts, gzipped again.
const edited = (tgz, find, replace, offset = 0) => {
  const tar = Buffer.from(gunzipSync(tgz))
  const at = tar.indexOf(find)
  assert.notEqual(at, -1)
  tar.write(replace, at + offset, 'latin1')
  return gzipSync(tar)
}

describe('gitTreeOfTarball', () => {
  it("is the id of the tree `git archive` wrote, a commit's included", async () => {
    assert.equal(await gitTreeOfTarball(TREE_TGZ), TREE)
    assert.equal(await gitTreeOfTarball(COMMIT_TGZ), TREE)
  })

  it("is another id for a file changed, a file's exec bit dropped, or a symlink, short or long, pointed elsewhere", async () => {
    // A header's mode is 100 bytes past its name, a symlink's target 157.
    const edits = [['export {}', 'export []'], ['acme-app-abc1234/run\0', '0000664', 100], ['acme-app-abc1234/link\0', 'lib/b.js', 157], ['linkpath=lib/x', 'linkpath=lib/y']]
    for (const [find, replace, offset] of edits) {
      const id = await gitTreeOfTarball(edited(TREE_TGZ, find, replace, offset))
      assert.match(id, /^[\da-f]{40}$/u, find)
      assert.notEqual(id, TREE, find)
    }
  })

  it('is a reason, never an id, where there is no tree to name', async () => {
    const tar = gunzipSync(TREE_TGZ)
    assert.equal(await gitTreeOfTarball(SUBMODULE_TGZ), 'no tree: an empty directory, "sub", and no submodule there')
    assert.equal(await gitTreeOfTarball(Buffer.from('not gzip')), 'no tree: not gzip, or larger than 1 GiB unpacked')
    assert.equal(await gitTreeOfTarball(gzipSync(tar.subarray(0, 1000))), 'no tree: the tarball is cut short')
    assert.equal(await gitTreeOfTarball(gzipSync(Buffer.alloc(1024))), 'no tree: an empty tarball')
    assert.match(await gitTreeOfTarball(edited(TREE_TGZ, 'acme-app-abc1234/lib/', 'acme-app-abc1235/lib/')), /^no tree: an entry outside one top directory/u)
    assert.match(await gitTreeOfTarball(edited(TREE_TGZ, 'acme-app-abc1234/lib/', 'acme-app-abc1234/../')), /^no tree: an entry outside one top directory/u)
    assert.equal(await gitTreeOfTarball(edited(TREE_TGZ, 'acme-app-abc1234/run\0', '..\0', 'acme-app-abc1234/'.length)), 'no tree: an entry outside one top directory, "acme-app-abc1234/.."')
    // A file alone, with no directory over it, which would otherwise read as the empty tree.
    const header = Buffer.alloc(512)
    header.write('file', 0)
    header.write('00000000000', 124)
    header.write('0', 156)
    assert.equal(await gitTreeOfTarball(gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))), 'no tree: an entry outside one top directory, "file"')
  })

  it("takes a submodule's commit from `submodules`, asked only for a tarball with an empty directory, and is the id only for the right one", async () => {
    const asked = []
    const submodules = (commit) => (paths) => {
      asked.push(paths)
      return new Map([['sub', commit]])
    }
    assert.equal(await gitTreeOfTarball(SUBMODULE_TGZ, submodules(SUBMODULE_COMMIT)), SUBMODULE)
    assert.deepEqual(asked, [['sub']])
    assert.equal(await gitTreeOfTarball(TREE_TGZ, submodules(SUBMODULE_COMMIT)), TREE)
    assert.equal(asked.length, 1)
    const other = await gitTreeOfTarball(SUBMODULE_TGZ, submodules(TREE))
    assert.match(other, /^[\da-f]{40}$/u)
    assert.notEqual(other, SUBMODULE)
    for (const commit of [undefined, SUBMODULE_COMMIT.toUpperCase(), SUBMODULE_COMMIT.slice(1), 42]) {
      assert.equal(await gitTreeOfTarball(SUBMODULE_TGZ, submodules(commit)), 'no tree: an empty directory, "sub", and no submodule there', String(commit))
    }
  })
})
