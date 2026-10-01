import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { gitTreeOfTarball } from '../src/tree.js'
import { COMMIT_TGZ, EMPTIES, EMPTIES_D, EMPTIES_N, EMPTIES_TGZ, SUBMODULE, SUBMODULE_COMMIT, SUBMODULE_TGZ, TREE, TREE_TGZ } from './tree-fixtures.js'

// A header's checksum, over the header with the field itself read as spaces.
const sign = (tar, start) => {
  tar.fill(' ', start + 148, start + 156)
  const sum = tar.subarray(start, start + 512).reduce((total, byte) => total + byte, 0)
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, start + 148, 'latin1')
}

// The tar inside, with `find` written over by `replace` at `offset` from
// where it starts, the header that falls in signed again, gzipped again.
const edited = (tgz, find, replace, offset = 0) => {
  const tar = Buffer.from(gunzipSync(tgz))
  const at = tar.indexOf(find) + offset
  assert.notEqual(at, offset - 1)
  tar.write(replace, at, 'latin1')
  const start = at - (at % 512)
  if (tar.toString('latin1', start + 257, start + 263) === 'ustar\0') sign(tar, start)
  return gzipSync(tar)
}

const header = (name, type, size = 0, mode = 0o664) => {
  const block = Buffer.alloc(512)
  block.write(name, 0)
  block.write(mode.toString(8).padStart(7, '0'), 100)
  block.write('0000000', 108)
  block.write('0000000', 116)
  block.write(size.toString(8).padStart(11, '0'), 124)
  block.write('root', 265)
  block.write('root', 297)
  block.write(type, 156)
  block.write('ustar\u000000', 257, 'latin1')
  sign(block, 0)
  return block
}
const body = (text) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc((512 - (text.length % 512)) % 512)])
// Two-digit records only: the length counts itself.
const pax = (type, records) => {
  const text = records.map(([key, value]) => ` ${key}=${value}\n`).map((rest) => `${rest.length + 2}${rest}`).join('')
  return [header('PaxHeader', type, text.length), body(text)]
}
const tarball = (...blocks) => gzipSync(Buffer.concat([...blocks.flat(), Buffer.alloc(1024)]))

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
    assert.equal(await gitTreeOfTarball(tarball(header('file', '0'))), 'no tree: an entry outside one top directory, "file"')
    // A top directory that is no directory, which would otherwise hash as any other.
    for (const top of ['..', '.', '']) {
      const blocks = [header(`${top}/`, '5', 0, 0o775), header(`${top}/f`, '0', 4), body('SAFE')]
      assert.equal(await gitTreeOfTarball(tarball(...blocks)), `no tree: an entry outside one top directory, ${JSON.stringify(`${top}/`)}`, top)
    }
  })

  it('is a reason where a tar extractor would read the tarball other than it is hashed', async () => {
    const top = header('top/', '5', 0, 0o775)
    const file = [header('top/f', '0', 4), body('SAFEEVIL')]
    assert.equal(await gitTreeOfTarball(tarball(top, file)), 'ef38c2e9ebb915617fbd4a188a4c5d3ba68b8022')
    const tampered = header('top/f', '0', 4)
    tampered[0] = 'T'.codePointAt(0)
    const gnu = header('top/f', '0', 4)
    gnu.write('ustar  \0', 257, 'latin1')
    sign(gnu, 0)
    const owned = header('top/f', '0', 4)
    owned.write('0001750', 108)
    sign(owned, 0)
    const named = header('top/f', '0', 4)
    named.write('evil', 265)
    sign(named, 0)
    for (const [blocks, reason] of [
      [[top, pax('x', [['size', 8]]), file], 'a pax record git does not write, "size"'],
      [[pax('g', [['path', 'top/x']]), top, file], 'a pax record git does not write, "path"'],
      [[top, pax('x', [['__proto__', 'x']]), file], 'a pax record git does not write, "__proto__"'],
      [[top, pax('x', [['path', 'top/a']]), pax('x', [['linkpath', 'x']]), file], 'two pax headers for one entry'],
      [[top, pax('x', [['linkpath', 'f\0x']]), header('top/l', '2', 0, 0o777)], 'a malformed pax header'],
      [[top, tampered, body('SAFE')], 'a header that fails its checksum'],
      [[top, gnu, body('SAFE')], 'a header that is not POSIX ustar'],
      [[top, header('top/f', '0', 4, 0o4775), body('SAFE')], 'a header git does not write, "top/f"'],
      [[top, header('top/f', '0', 4, 0o000), body('SAFE')], 'a header git does not write, "top/f"'],
      [[top, header('top/d/', '5', 0, 0o700)], 'a header git does not write, "top/d/"'],
      [[top, header('top/l', '2', 4, 0o777), body('SAFE')], 'a header git does not write, "top/l"'],
      [[top, header('top/f/', '0', 4), body('SAFE')], 'a header git does not write, "top/f/"'],
      [[top, header('top/d', '5', 0, 0o775)], 'a header git does not write, "top/d"'],
      [[top, owned, body('SAFE')], 'a header git does not write, "top/f"'],
      [[top, named, body('SAFE')], 'a header git does not write, "top/f"'],
      [[top, header('top/h', '1', 0, 0o664)], 'an entry of type "1"'],
      [[top, file, Buffer.alloc(1024), header('top/g', '0')], 'data after the end of the tarball'],
    ]) {
      assert.equal(await gitTreeOfTarball(tarball(...blocks)), `no tree: ${reason}`, reason)
    }
  })

  it('refuses a NUL in a pax path, which hashes as the entries after it and extracts as the name before it', async () => {
    const top = header('top/', '5', 0, 0o775)
    const twoFiles = tarball(top, header('top/f', '0', 4), body('SAFE'), header('top/g', '0', 4), body('EVIL'))
    assert.match(await gitTreeOfTarball(twoFiles), /^[\da-f]{40}$/u)
    // `f`, its blob id, then `g`'s mode and name: as git serializes the two.
    const name = `top/f\0${createHash('sha1').update('blob 4\0SAFE').digest('latin1')}100644 g`
    assert.equal(await gitTreeOfTarball(tarball(top, pax('x', [['path', name]]), header('top/x', '0', 4), body('EVIL'))), 'no tree: a malformed pax header')
  })

  it("takes a submodule's commit from `list`, asked only for a tarball with an empty directory, and is the id only for the right one", async () => {
    const asked = []
    const list = (commit) => (sha) => {
      asked.push(sha)
      return [{ path: 'sub', type: 'commit', sha: commit }]
    }
    assert.equal(await gitTreeOfTarball(SUBMODULE_TGZ, { expected: SUBMODULE, list: list(SUBMODULE_COMMIT) }), SUBMODULE)
    assert.deepEqual(asked, [SUBMODULE])
    assert.equal(await gitTreeOfTarball(TREE_TGZ, { expected: TREE, list: list(SUBMODULE_COMMIT) }), TREE)
    assert.equal(asked.length, 1)
    const other = await gitTreeOfTarball(SUBMODULE_TGZ, { expected: SUBMODULE, list: list(TREE) })
    assert.match(other, /^[\da-f]{40}$/u)
    assert.notEqual(other, SUBMODULE)
    for (const commit of [undefined, SUBMODULE_COMMIT.toUpperCase(), SUBMODULE_COMMIT.slice(1), 42]) {
      assert.equal(await gitTreeOfTarball(SUBMODULE_TGZ, { expected: SUBMODULE, list: list(commit) }), 'no tree: an empty directory, "sub", and no submodule there', String(commit))
    }
  })

  it('puts back the subtrees with no file in them that `git archive` leaves out, listed and shown to hold nothing', async () => {
    const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const tree = (path, sha) => ({ path, type: 'tree', sha })
    const listings = {
      [EMPTIES]: [{ path: 'd', type: 'tree', sha: EMPTIES_D }, tree('empty', EMPTY), { path: 'f', type: 'blob', sha: 'b'.repeat(40) }, tree('n', EMPTIES_N)],
      [EMPTIES_D]: [tree('e', EMPTY), { path: 'g', type: 'blob', sha: 'c'.repeat(40) }],
      [EMPTIES_N]: [tree('m', EMPTY)],
    }
    const asked = []
    const list = (sha) => {
      asked.push(sha)
      return listings[sha] ?? []
    }
    assert.notEqual(await gitTreeOfTarball(EMPTIES_TGZ), EMPTIES)
    assert.equal(await gitTreeOfTarball(EMPTIES_TGZ, { expected: EMPTIES, list }), EMPTIES)
    assert.deepEqual(asked.toSorted(), [EMPTIES, EMPTIES_D, EMPTIES_N].toSorted())
    // A name no tree has is passed over.
    const odd = (sha) => (sha === EMPTIES ? [...list(sha), tree('x\0y', EMPTY), tree('x/y', EMPTY), tree('', EMPTY)] : list(sha))
    assert.equal(await gitTreeOfTarball(EMPTIES_TGZ, { expected: EMPTIES, list: odd }), EMPTIES)
    // A file left out is never asked after as a subtree.
    asked.length = 0
    const left = tarball(header('top/', '5', 0, 0o775), header('top/d/', '5', 0, 0o775), header('top/d/g', '0', 2), body('g\n'))
    assert.notEqual(await gitTreeOfTarball(left, { expected: EMPTIES, list }), EMPTIES)
    assert.deepEqual(asked.toSorted(), [EMPTIES, EMPTIES_D, EMPTIES_N].toSorted())
    // Listed where nothing is missing, so never asked.
    asked.length = 0
    assert.equal(await gitTreeOfTarball(TREE_TGZ, { expected: TREE, list }), TREE)
    assert.deepEqual(asked, [])
    // Nor is a subtree whose listing is not its id's.
    for (const n of [[{ path: 'm', type: 'blob', sha: 'b'.repeat(40) }], [tree('m', EMPTY), tree('k', EMPTY)], [tree('m', 42)], [null], []]) {
      const id = await gitTreeOfTarball(EMPTIES_TGZ, { expected: EMPTIES, list: (sha) => (sha === EMPTIES_N ? n : list(sha)) })
      assert.match(id, /^[\da-f]{40}$/u)
      assert.notEqual(id, EMPTIES)
    }
  })

  it('puts back no subtree a file is in, where the tarball has it or not', async () => {
    const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const top = header('top/', '5', 0, 0o775)
    const f = [header('top/f', '0', 2), body('x\n')]
    // {f, empty: the empty tree}, with `empty` a file in the tarball.
    const withFile = '1fa92f070ee4fa03ec6dab55560a3a8d0456e264'
    const files = { [withFile]: [{ path: 'f', type: 'blob', sha: 'b'.repeat(40) }, { path: 'empty', type: 'tree', sha: EMPTY }] }
    assert.equal(await gitTreeOfTarball(tarball(top, f), { expected: withFile, list: (sha) => files[sha] }), withFile)
    assert.notEqual(await gitTreeOfTarball(tarball(top, f, header('top/empty', '0')), { expected: withFile, list: (sha) => files[sha] }), withFile)
    // {f, x: {sub: EMPTIES_D}}, `x` holding only a subtree, which holds `g`.
    const deeper = '93c4c8cc3e271464294ca228764424b6be154d44'
    const x = '4e12ab93d049e20500805196eb7ac3913da9d20d'
    const listings = {
      [deeper]: [{ path: 'f', type: 'blob', sha: 'b'.repeat(40) }, { path: 'x', type: 'tree', sha: x }],
      [x]: [{ path: 'sub', type: 'tree', sha: EMPTIES_D }],
      [EMPTIES_D]: [{ path: 'e', type: 'tree', sha: EMPTY }, { path: 'g', type: 'blob', sha: 'c'.repeat(40) }],
    }
    assert.notEqual(await gitTreeOfTarball(tarball(top, f), { expected: deeper, list: (sha) => listings[sha] ?? [] }), deeper)
  })
})
