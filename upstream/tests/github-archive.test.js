import assert from 'node:assert/strict'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { gitTreeOfArchive } from '../src/exported.js'
import { EOL, EOL_BLOB, EOL_COMMIT, EOL_LISTING, EOL_TGZ, EXPORTED, EXPORTED_BLOBS, EXPORTED_COMMIT, EXPORTED_LISTINGS, EXPORTED_TGZ, LFS, LFS_COMMIT, LFS_TGZ, LINK, LINK_COMMIT, LINK_LISTING, LINK_TGZ, SUBST, SUBST_COMMIT, SUBST_TGZ } from './archive-fixtures.js'
import { forbidRequests, json, stubGitHub } from './github-stub.js'
import { COMMIT_TGZ, SUBMODULE_COMMIT, TREE, TREE_TGZ } from './tree-fixtures.js'

const CACHE_DIR = join(tmpdir(), `upstream-github-archive-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const ARCHIVES = join(CACHE_DIR, 'github', 'archives')

const realFetch = globalThis.fetch
const client = () => createClient({ token: 't0ken' })
const API = 'https://api.github.com/repos/acme/app'
const COMMITS = { [EXPORTED_COMMIT]: { sha: EXPORTED_COMMIT, tree: { sha: EXPORTED } }, [SUBST_COMMIT]: { sha: SUBST_COMMIT, tree: { sha: SUBST } }, [SUBMODULE_COMMIT]: { sha: SUBMODULE_COMMIT, tree: { sha: TREE } }, [LFS_COMMIT]: { sha: LFS_COMMIT, tree: { sha: LFS } } }
const TARBALLS = { [EXPORTED_COMMIT]: EXPORTED_TGZ, [SUBST_COMMIT]: SUBST_TGZ, [SUBMODULE_COMMIT]: COMMIT_TGZ }

// GitHub, for acme/app: each archive by its commit, commits, listings and
// blobs by id. `calls` is every URL asked for.
function stub({ tarballs = TARBALLS, listings = EXPORTED_LISTINGS, blobs = EXPORTED_BLOBS } = {}) {
  return stubGitHub(({ url, headers }) => {
    const path = new URL(url).pathname.slice('/repos/acme/app/'.length)
    const [kind, id] = [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)]
    if (kind === 'tarball' && Object.hasOwn(tarballs, id)) return new Response(tarballs[id])
    if (kind === 'git/commits' && Object.hasOwn(COMMITS, id)) return json(COMMITS[id])
    if (kind === 'git/trees' && Object.hasOwn(listings, id)) return json({ sha: id, tree: listings[id], truncated: false })
    if (kind === 'git/blobs' && headers.Accept === 'application/vnd.github.raw' && Object.hasOwn(blobs, id)) return new Response(blobs[id])
    return json({ message: 'Not Found' }, 404)
  })
}
const urls = (calls) => calls.map(({ url }) => url.slice(API.length + 1))
const exported = (sha = EXPORTED_COMMIT) => client().getRepoTarball({ repo: 'acme/app', sha, exported: true })
const retar = (tgz, edit) => gzipSync(edit(gunzipSync(tgz)))

beforeEach(() => rm(CACHE_DIR, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => rm(CACHE_DIR, { recursive: true, force: true }))

describe('getRepoTarball exported', () => {
  it("fetches the commit's own archive, held to its tree as its .gitattributes leave things out", async () => {
    const calls = stub()
    assert.deepEqual(Buffer.from(await exported()), EXPORTED_TGZ)
    // The listings of the directories missing something, those beneath the
    // top asked for at once, and the blob of the top .gitattributes, which
    // is left out; src's own is read from the archive. tests, left out
    // whole, is never listed.
    assert.deepEqual(urls(calls), [`git/commits/${EXPORTED_COMMIT}`, `tarball/${EXPORTED_COMMIT}`, `git/trees/${EXPORTED}`, 'git/trees/d184003c45e7e16dffd8be2c94ba48f842a945d8', 'git/trees/d38020b6559d20f8b70255b55ff42a980d9cb01b', 'git/blobs/fde205cf5791114e567d38892489a81a0039188a'])
    assert.equal(calls[1].redirect, 'follow')
    assert.deepEqual(await readdir(ARCHIVES), [`${EXPORTED_COMMIT}.tgz`])
  })

  it('needs no listing where the archive holds the whole tree, global header and all', async () => {
    const calls = stub()
    assert.deepEqual(Buffer.from(await exported(SUBMODULE_COMMIT)), COMMIT_TGZ)
    assert.deepEqual(urls(calls), [`git/commits/${SUBMODULE_COMMIT}`, `tarball/${SUBMODULE_COMMIT}`])
  })

  it('holds a cached archive to the tree again, from cached listings and blobs, and throws on one that is not', async () => {
    stub()
    await exported()
    const calls = stub({ tarballs: {} })
    assert.deepEqual(Buffer.from(await exported()), EXPORTED_TGZ)
    // The listings and blobs are kept by their ids too: only the commit is
    // asked, and one kept that is not what its id names is asked again.
    assert.deepEqual(urls(calls), [`git/commits/${EXPORTED_COMMIT}`])
    await writeFile(join(CACHE_DIR, 'github', 'listings', `${EXPORTED}.json`), '[]')
    await writeFile(join(CACHE_DIR, 'github', 'blobs', 'fde205cf5791114e567d38892489a81a0039188a'), '* export-ignore\n')
    const again = stub({ tarballs: {} })
    assert.deepEqual(Buffer.from(await exported()), EXPORTED_TGZ)
    assert.deepEqual(urls(again), [`git/commits/${EXPORTED_COMMIT}`, `git/trees/${EXPORTED}`, 'git/blobs/fde205cf5791114e567d38892489a81a0039188a'])
    await writeFile(join(ARCHIVES, `${EXPORTED_COMMIT}.tgz`), COMMIT_TGZ)
    await assert.rejects(exported(), new RegExp(`getRepoTarball: integrity mismatch for ${EXPORTED_COMMIT} from the cache: expected ${EXPORTED}, got no tree: a global header that does not name ${EXPORTED_COMMIT}$`, 'u'))
  })

  it('refuses a file git rewrites, as export-subst has it', async () => {
    stub()
    await assert.rejects(exported(SUBST_COMMIT), /got no tree: "version\.txt" is not the tree's, as git rewrites a file marked export-subst or ident, or for its working-tree-encoding$/u)
    assert.deepEqual(await readdir(ARCHIVES).catch(() => []), [])
  })

  it('refuses an archive with a Git LFS pointer, fetched or cached, as it is the setting of the repo, which can change, not the commit', async () => {
    stub({ tarballs: { [LFS_COMMIT]: LFS_TGZ } })
    await assert.rejects(exported(LFS_COMMIT), /got no tree: "big\.bin" is a Git LFS pointer, which GitHub swaps for its object/u)
    assert.deepEqual(await readdir(ARCHIVES).catch(() => []), [])
    // Cached while the repo was set not to swap it: refused all the same.
    await mkdir(ARCHIVES, { recursive: true })
    await writeFile(join(ARCHIVES, `${LFS_COMMIT}.tgz`), LFS_TGZ)
    stub({ tarballs: {} })
    await assert.rejects(exported(LFS_COMMIT), /from the cache: expected \w+, got no tree: "big\.bin" is a Git LFS pointer/u)
  })

  it("refuses the tree's tarball, which names no commit, and an archive of another commit", async () => {
    stub({ tarballs: { [EXPORTED_COMMIT]: TREE_TGZ } })
    await assert.rejects(exported(), /got no tree: "a-b" is in the archive, not the tree$/u)
    stub({ tarballs: { [EXPORTED_COMMIT]: SUBST_TGZ } })
    await assert.rejects(exported(), new RegExp(`got no tree: a global header that does not name ${EXPORTED_COMMIT}$`, 'u'))
  })

  it('refuses listings and blobs that are not what they are asked for', async () => {
    const root = EXPORTED_LISTINGS[EXPORTED]
    stub({ listings: { ...EXPORTED_LISTINGS, [EXPORTED]: root.slice(1) } })
    await assert.rejects(exported(), new RegExp(`got no tree: GitHub's listing of tree ${EXPORTED} is not that tree$`, 'u'))
    stub({ blobs: { fde205cf5791114e567d38892489a81a0039188a: '* export-ignore\n' } })
    await assert.rejects(exported(), /got no tree: GitHub's blob fde205cf5791114e567d38892489a81a0039188a, "\.gitattributes", is not that blob$/u)
  })

  it('takes exported as a boolean alone', async () => {
    const calls = forbidRequests()
    for (const value of [1, 'true', null]) {
      await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: EXPORTED_COMMIT, exported: value }), /getRepoTarball: exported must be a boolean/u)
    }
    assert.deepEqual(calls, [])
  })
})

describe('gitTreeOfArchive', () => {
  const list = (sha) => EXPORTED_LISTINGS[sha] ?? []
  const blob = (sha) => new TextEncoder().encode(EXPORTED_BLOBS[sha])
  const check = (tgz, commit = EXPORTED_COMMIT) => gitTreeOfArchive(tgz, { expected: EXPORTED, commit, list, blob })
  const sum = (tar, at) => {
    tar.fill(0x20, at + 148, at + 156)
    tar.write(`${tar.subarray(at, at + 512).reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0')}\0`, at + 148, 'latin1')
    return tar
  }
  // A header's name field in place, its checksum made good again.
  const rename = (from, to) => (tar) => {
    const at = tar.indexOf(from)
    tar.fill(0, at, at + 100).write(to, at, 'latin1')
    return sum(tar, at - (at % 512))
  }
  // `name` added before `next`'s entry as an empty copy of it.
  const add = (next, name) => (tar) => {
    const at = tar.indexOf(next)
    const header = Buffer.from(tar.subarray(at, at + 512))
    header.fill(0, 0, 100).write(name, 0, 'latin1')
    header.fill(0x30, 124, 135)
    return Buffer.concat([tar.subarray(0, at), sum(header, 0), tar.subarray(at)])
  }

  it('is the tree id of an archive as git exports it', async () => {
    assert.equal(await check(EXPORTED_TGZ), EXPORTED)
  })

  it('refuses a file the .gitattributes leave out, and one they do not, missing', async () => {
    assert.equal(await check(retar(EXPORTED_TGZ, rename('acme-app-6e456ae/run', 'acme-app-6e456ae/phpunit.xml.dist'))), 'no tree: "phpunit.xml.dist" is in the archive, though the tree\'s .gitattributes mark it export-ignore')
    assert.equal(await check(retar(EXPORTED_TGZ, rename('acme-app-6e456ae/run', 'acme-app-6e456ae/ran'))), 'no tree: "ran" is in the archive, not the tree')
    assert.equal(await check(retar(EXPORTED_TGZ, add('acme-app-6e456ae/src/a.php', 'acme-app-6e456ae/src/secret.txt'))), 'no tree: "src/secret.txt" is in the archive, though the tree\'s .gitattributes mark it export-ignore')
    assert.equal(await check(retar(EXPORTED_TGZ, add('acme-app-6e456ae/src/a.php', 'acme-app-6e456ae/tests/t.php'))), 'no tree: "tests/" is in the archive, though the tree\'s .gitattributes mark it export-ignore')
  })

  it('takes a file its eol attribute has git write with CRLF line ends, held to its blob so written', async () => {
    const encode = (text) => new TextEncoder().encode(text)
    const objects = { expected: EOL, commit: EOL_COMMIT, list: (sha) => (sha === EOL ? EOL_LISTING : []) }
    const asked = []
    const served = (sha) => {
      asked.push(sha)
      return encode(sha === EOL_BLOB[0] ? EOL_BLOB[1] : '')
    }
    assert.equal(await gitTreeOfArchive(EOL_TGZ, { ...objects, blob: served }), EOL)
    assert.deepEqual(asked, [EOL_BLOB[0]])
    assert.equal(await gitTreeOfArchive(EOL_TGZ, { ...objects, blob: () => encode('a\r\nb\r\n') }), `no tree: GitHub's blob ${EOL_BLOB[0]}, "a.txt", is not that blob`)
    const edited = retar(EOL_TGZ, (tar) => {
      tar.write('c', tar.indexOf('a\r\nb\r\n') + 3, 'latin1')
      return tar
    })
    assert.equal(await gitTreeOfArchive(edited, { ...objects, blob: served }), 'no tree: "a.txt" is not the tree\'s, as git rewrites a file marked export-subst or ident, or for its working-tree-encoding')
  })

  it('holds a link to its blob as it is, whatever eol attributes say of it', async () => {
    const blobs = { '92be83e26d2715c1f096e9e9d666ff9a67837a81': '* text eol=crlf\n', '78981922613b2afb6025042ff6bd878ac1994e85': 'a\n' }
    const objects = { expected: LINK, commit: LINK_COMMIT, list: (sha) => (sha === LINK ? LINK_LISTING : []), blob: (sha) => new TextEncoder().encode(blobs[sha] ?? '') }
    assert.equal(await gitTreeOfArchive(LINK_TGZ, objects), LINK)
    const relinked = retar(LINK_TGZ, (tar) => {
      const at = tar.indexOf(`acme-app-${LINK_COMMIT.slice(0, 7)}/l\0`)
      tar.write('b', at + 157, 'latin1')
      return sum(tar, at)
    })
    assert.equal(await gitTreeOfArchive(relinked, objects), 'no tree: "l" is not the tree\'s, as git rewrites a file marked export-subst or ident, or for its working-tree-encoding')
  })

  it('refuses an archive with a Git LFS pointer in it, though it is the tree whole, as GitHub swaps one by a setting of the repo', async () => {
    const message = 'no tree: "big.bin" is a Git LFS pointer, which GitHub swaps for its object in the archive of a repo set to include them, so that the archive is that setting\'s, not the commit\'s'
    assert.equal(await gitTreeOfArchive(LFS_TGZ, { expected: LFS, commit: LFS_COMMIT, list: () => [], blob: () => new Uint8Array() }), message)
    // Not a pointer: not the spec's line, or of a spec git-lfs does not know.
    const edit = (at, text) => retar(LFS_TGZ, (tar) => {
      tar.write(text, tar.indexOf('version https://git-lfs') + at, 'latin1')
      return tar
    })
    for (const tgz of [edit(0, 'V'), edit(0, 'version https://git-lfs.github.com/spec/v2')]) {
      assert.match(await gitTreeOfArchive(tgz, { expected: LFS, commit: LFS_COMMIT, list: () => [], blob: () => new Uint8Array() }), /^no tree: GitHub's listing of tree/u)
    }
  })

  it('refuses a directory where git writes none, and none where it writes one', async () => {
    assert.equal(await check(retar(EXPORTED_TGZ, rename('acme-app-6e456ae/docs/', 'acme-app-6e456ae/doc/'))), 'no tree: "doc" is in the archive, not the tree')
    // docs, whose one file is left out, is written all the same.
    const dropped = retar(EXPORTED_TGZ, (tar) => {
      const at = tar.indexOf('acme-app-6e456ae/docs/\0')
      return Buffer.concat([tar.subarray(0, at), tar.subarray(at + 512)])
    })
    assert.equal(await check(dropped), 'no tree: "docs/" is not in the archive, though git writes a directory where it reaches a file, and only there')
  })
})
