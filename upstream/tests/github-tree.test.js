import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { SHA, forbidRequests, json, stubGitHub } from './github-stub.js'
import { CRLF, CRLF_ANDROID, CRLF_TGZ, EMPTIES, EMPTIES_D, EMPTIES_N, EMPTIES_TGZ, LISTINGS, NESTED, NESTED_COMMIT, NESTED_LIB, NESTED_TGZ, SUBMODULE, SUBMODULE_COMMIT, SUBMODULE_TGZ, TREE, TREE_LIB, TREE_TGZ } from './tree-fixtures.js'

const CACHE_DIR = join(tmpdir(), `upstream-github-tree-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const TREES = join(CACHE_DIR, 'github', 'trees')

const realFetch = globalThis.fetch
const client = () => createClient({ token: 't0ken' })
const API = 'https://api.github.com/repos/acme/app'
const gzip = (bytes) => new Response(bytes, { headers: { 'content-type': 'application/x-gzip' } })

// GitHub, for acme/app: `tarballs` by the ref asked, `commits` and
// `listings` by id. `calls` is every URL asked for.
function stub({ tarballs = {}, commits = {}, listings = {} } = {}) {
  return stubGitHub(({ url }) => {
    const { pathname, search } = new URL(url)
    const path = pathname.slice('/repos/acme/app/'.length)
    const [kind, id] = [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)]
    if (kind === 'tarball' && Object.hasOwn(tarballs, id)) return gzip(tarballs[id])
    if (kind === 'git/commits' && Object.hasOwn(commits, id)) return json(commits[id])
    if (kind === 'git/trees' && search === '' && Object.hasOwn(listings, id)) return json(listings[id])
    return json({ message: 'Not Found' }, 404)
  })
}
const urls = (calls) => calls.map(({ url }) => url)
const SUBMODULE_LISTING = { sha: SUBMODULE, truncated: false, tree: [{ path: 'lib', mode: '040000', type: 'tree', sha: SHA }, { path: 'sub', mode: '160000', type: 'commit', sha: SUBMODULE_COMMIT }] }

beforeEach(() => rm(CACHE_DIR, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => rm(CACHE_DIR, { recursive: true, force: true }))

describe('getRepoTreeTarball', () => {
  it('fetches the tarball of a tree by its id, following the redirect, and holds it to the id', async () => {
    const calls = stub({ tarballs: { [TREE]: TREE_TGZ } })
    const bytes = await client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE })
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(Buffer.from(bytes), TREE_TGZ)
    assert.deepEqual(calls.map(({ url, redirect, headers }) => [url, redirect, headers.Authorization]), [[`${API}/tarball/${TREE}`, 'follow', 'Bearer t0ken']])
  })

  it('refuses the tarball of another tree, or of this one changed, and caches nothing', async () => {
    const tar = Buffer.from(gunzipSync(TREE_TGZ))
    tar.write('export []', tar.indexOf('export {}'), 'latin1')
    for (const [tree, served] of [[SUBMODULE, TREE_TGZ], [TREE, gzipSync(tar)]]) {
      stub({ tarballs: { [tree]: served }, listings: { [tree]: { tree: [] } } })
      await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree }), new RegExp(`getRepoTreeTarball: integrity mismatch for ${tree} from ${API.replaceAll('.', '\\.')}/tarball/${tree}: expected ${tree}, got [\\da-f]{40}$`, 'u'))
    }
    assert.deepEqual(await readdir(TREES).catch(() => []), [])
  })

  it("takes a submodule's commit from GitHub's listing of the tree, asked only for a tarball with one", async () => {
    let calls = stub({ tarballs: { [SUBMODULE]: SUBMODULE_TGZ }, listings: { [SUBMODULE]: SUBMODULE_LISTING } })
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/app', tree: SUBMODULE })), SUBMODULE_TGZ)
    assert.deepEqual(urls(calls), [`${API}/tarball/${SUBMODULE}`, `${API}/git/trees/${SUBMODULE}`])
    calls = stub({ listings: { [SUBMODULE]: SUBMODULE_LISTING } })
    await client().getRepoTreeTarball({ repo: 'acme/app', tree: SUBMODULE })
    assert.deepEqual(urls(calls), [`${API}/git/trees/${SUBMODULE}`])
  })

  it('walks down to a submodule a directory listing at a time, never by an id that is not one', async () => {
    const lib = (sha) => ({ tree: [{ path: 'lib', mode: '040000', type: 'tree', sha }] })
    const listings = { [NESTED]: lib(NESTED_LIB), [NESTED_LIB]: { tree: [{ path: 'a.js', mode: '100644', type: 'blob', sha: SHA }, { path: 'sub', mode: '160000', type: 'commit', sha: NESTED_COMMIT }] } }
    let calls = stub({ tarballs: { [NESTED]: NESTED_TGZ }, listings })
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/app', tree: NESTED })), NESTED_TGZ)
    assert.deepEqual(urls(calls), [`${API}/tarball/${NESTED}`, `${API}/git/trees/${NESTED}`, `${API}/git/trees/${NESTED_LIB}`])
    await rm(CACHE_DIR, { recursive: true, force: true })
    calls = stub({ tarballs: { [NESTED]: NESTED_TGZ }, listings: { ...listings, [NESTED]: lib('../x') } })
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: NESTED }), /got no tree: an empty directory, "lib\/sub", and no submodule there$/u)
    assert.deepEqual(urls(calls), [`${API}/tarball/${NESTED}`, `${API}/git/trees/${NESTED}`])
  })

  it('puts back the subtrees with no file in them that the tarball leaves out, from the listings of those whose id differs', async () => {
    const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const tree = (path, sha) => ({ path, mode: '040000', type: 'tree', sha })
    const listings = {
      [EMPTIES]: { tree: [tree('d', EMPTIES_D), tree('empty', EMPTY), { path: 'f', mode: '100644', type: 'blob', sha: SHA }, tree('n', EMPTIES_N)] },
      [EMPTIES_D]: { tree: [tree('e', EMPTY), { path: 'g', mode: '100644', type: 'blob', sha: SHA }] },
      [EMPTIES_N]: { tree: [tree('m', EMPTY)] },
    }
    const calls = stub({ tarballs: { [EMPTIES]: EMPTIES_TGZ }, listings })
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/app', tree: EMPTIES })), EMPTIES_TGZ)
    assert.deepEqual(urls(calls), [`${API}/tarball/${EMPTIES}`, ...[EMPTIES, EMPTIES_D, EMPTIES_N].map((id) => `${API}/git/trees/${id}`)])
  })

  it('takes a file GitHub has with CRLF for `eol=crlf` as a checkout writes it, held to the blob the listing has with LF', async () => {
    const listings = { [CRLF]: { tree: LISTINGS[CRLF] }, [CRLF_ANDROID]: { tree: LISTINGS[CRLF_ANDROID] } }
    let calls = stub({ tarballs: { [CRLF]: CRLF_TGZ }, listings })
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/app', tree: CRLF })), CRLF_TGZ)
    const asked = [CRLF, CRLF_ANDROID].map((id) => `${API}/git/trees/${id}`)
    assert.deepEqual(urls(calls), [`${API}/tarball/${CRLF}`, ...asked])
    assert.deepEqual(await readFile(join(TREES, `${CRLF}.tgz`)), CRLF_TGZ)
    // Cached as GitHub has it, so held to the listings again when read back.
    calls = stub({ listings })
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/app', tree: CRLF })), CRLF_TGZ)
    assert.deepEqual(urls(calls), asked)
  })

  it('refuses a submodule the listing has not, or names another commit for', async () => {
    for (const tree of [[], [{ path: 'sub', mode: '160000', type: 'commit', sha: SHA }], [{ path: 'sub', type: 'tree', sha: SUBMODULE_COMMIT }]]) {
      stub({ tarballs: { [SUBMODULE]: SUBMODULE_TGZ }, listings: { [SUBMODULE]: { ...SUBMODULE_LISTING, tree } } })
      await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: SUBMODULE }), /getRepoTreeTarball: integrity mismatch for [\da-f]{40} from https:/u, JSON.stringify(tree))
    }
    assert.deepEqual(await readdir(TREES).catch(() => []), [])
  })

  it('keeps it by the tree id alone, serving it again with no request, and throws on cached bytes that no longer match', async () => {
    stub({ tarballs: { [TREE]: TREE_TGZ } })
    await client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE })
    assert.deepEqual(await readdir(TREES), [`${TREE}.tgz`])
    assert.deepEqual(await readFile(join(TREES, `${TREE}.tgz`)), TREE_TGZ)
    const calls = forbidRequests()
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/fork', tree: TREE })), TREE_TGZ)
    await writeFile(join(TREES, `${TREE}.tgz`), TREE_TGZ.subarray(0, 100))
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE }), /getRepoTreeTarball: integrity mismatch for [\da-f]{40} from the cache/u)
    assert.deepEqual(calls, [])
  })

  it('takes only a full tree id, before any request', async () => {
    const calls = forbidRequests()
    for (const tree of [undefined, '', 'main', 'v1.0.0', TREE.slice(0, 7), TREE.toUpperCase(), `${TREE}0`, 'a'.repeat(64), `${TREE}/..`]) {
      await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree }), /getRepoTreeTarball: tree must be a full tree id/u, String(tree))
    }
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme', tree: TREE }), /getRepoTreeTarball: repo must be "owner\/name"/u)
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE, path: 'lib' }), /getRepoTreeTarball: unknown option path/u)
    assert.deepEqual(calls, [])
  })

  it('throws a HttpError for a failed tarball', async () => {
    stub()
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE }), { name: 'HttpError', status: 404, message: `GET ${API}/tarball/${TREE} 404: {"message":"Not Found"}` })
  })
})

describe('getRepoTarball', () => {
  const commit = { sha: SHA, tree: { sha: TREE } }

  it("fetches the tarball of the tree GitHub names for the commit, following the redirect, held to that tree", async () => {
    const calls = stub({ commits: { [SHA]: commit }, tarballs: { [TREE]: TREE_TGZ } })
    assert.deepEqual(Buffer.from(await client().getRepoTarball({ repo: 'acme/app', sha: SHA })), TREE_TGZ)
    assert.deepEqual(calls.map(({ url, redirect, headers }) => [url, redirect, headers.Authorization]), [[`${API}/git/commits/${SHA}`, 'manual', 'Bearer t0ken'], [`${API}/tarball/${TREE}`, 'follow', 'Bearer t0ken']])
    assert.deepEqual(await readdir(TREES), [`${TREE}.tgz`])
  })

  it('shares the cache with getRepoTreeTarball, asking only for the commit', async () => {
    stub({ tarballs: { [TREE]: TREE_TGZ } })
    await client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE })
    const calls = stub({ commits: { [SHA]: commit } })
    assert.deepEqual(Buffer.from(await client().getRepoTarball({ repo: 'acme/app', sha: SHA })), TREE_TGZ)
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`])
  })

  it('refuses a commit GitHub answers for another sha or without a tree, and a tarball of another tree', async () => {
    for (const answer of [{ ...commit, sha: SUBMODULE_COMMIT }, { sha: SHA }, { sha: SHA, tree: { sha: TREE.toUpperCase() } }, null]) {
      stub({ commits: { [SHA]: answer }, tarballs: { [TREE]: TREE_TGZ } })
      await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: SHA }), new RegExp(`getRepoTarball: GitHub names no tree for acme/app@${SHA}`, 'u'), JSON.stringify(answer))
    }
    stub({ commits: { [SHA]: { sha: SHA, tree: { sha: SUBMODULE } } }, tarballs: { [SUBMODULE]: TREE_TGZ }, listings: { [SUBMODULE]: { tree: [] } } })
    await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: SHA }), new RegExp(`getRepoTarball: integrity mismatch for ${SUBMODULE} from ${API.replaceAll('.', '\\.')}/tarball/${SUBMODULE}`, 'u'))
    assert.deepEqual(await readdir(TREES).catch(() => []), [])
  })

  it('takes only a full commit sha, not a branch, a tag, a path or an abbreviation', async () => {
    const calls = forbidRequests()
    for (const sha of [undefined, '', 'main', 'v1.0.0', '..', 'abc123', SHA.toUpperCase(), `${SHA}/..`, `${SHA}0`, 'a'.repeat(65)]) {
      await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha }), /getRepoTarball: sha must be a full commit sha/u, String(sha))
    }
    assert.deepEqual(calls, [])
  })

  it('throws a HttpError for a commit GitHub does not have', async () => {
    stub()
    await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: SHA }), { name: 'HttpError', status: 404, message: `GET ${API}/git/commits/${SHA} 404: {"message":"Not Found"}` })
  })
})

// A commit of TREE, and GitHub's listings of it and its `lib`, as GitHub
// answers them, a `url` on each entry.
const answer = (id, tree = LISTINGS[id]) => ({ sha: id, url: `${API}/git/trees/${id}`, tree: tree.map((entry) => ({ ...entry, url: `${API}/git/${entry.type}s/${entry.sha}` })), truncated: false })
const GITHUB = { commits: { [SHA]: { sha: SHA, tree: { sha: TREE } } }, listings: { [TREE]: answer(TREE), [TREE_LIB]: answer(TREE_LIB), [SUBMODULE]: answer(SUBMODULE) } }
const A = LISTINGS[TREE].find(({ path }) => path === 'a').sha

describe('getRepoTreeId', () => {
  it("is the commit's tree without a path, asking only for the commit", async () => {
    const calls = stub(GITHUB)
    assert.equal(await client().getRepoTreeId({ repo: 'acme/app', sha: SHA }), TREE)
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`])
  })

  it("is a directory's tree, from the listings down to it, the last one not asked for", async () => {
    let calls = stub(GITHUB)
    assert.equal(await client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'lib' }), TREE_LIB)
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`, `${API}/git/trees/${TREE}`])
    calls = stub(GITHUB)
    assert.equal(await client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'a' }), A)
  })

  it('takes `path`, its old name for `directory`, alike', async () => {
    const calls = stub(GITHUB)
    assert.equal(await client().getRepoTreeId({ repo: 'acme/app', sha: SHA, path: 'lib' }), TREE_LIB)
    assert.deepEqual(await client().listRepoDir({ repo: 'acme/app', sha: SHA, path: 'lib' }), LISTINGS[TREE_LIB].map(({ path, mode, type, sha }) => ({ path, mode, type, sha })))
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`, `${API}/git/trees/${TREE}`, `${API}/git/commits/${SHA}`, `${API}/git/trees/${TREE}`, `${API}/git/trees/${TREE_LIB}`])
  })

  it('refuses a directory that is none: a file, a symlink, a submodule, nothing, or under a file', async () => {
    for (const directory of ['run', 'link', 'nope', 'Lib', 'lib/a.js', 'lib/nope', 'run/x']) {
      stub(GITHUB)
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory }), new RegExp(`^AssertionError.*getRepoTreeId: acme/app@${SHA} has no directory at ${JSON.stringify(directory).replace('/', '\\/')}$`, 'u'), directory)
    }
    stub({ ...GITHUB, commits: { [SHA]: { sha: SHA, tree: { sha: SUBMODULE } } } })
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'sub' }), /getRepoTreeId: acme\/app@\w+ has no directory at "sub"$/u)
  })

  it("refuses a listing on the way that is not the tree's: an entry changed, left out or added", async () => {
    const entries = LISTINGS[TREE]
    for (const tree of [entries.with(5, { ...entries[5], sha: SHA }), entries.slice(0, -1), [...entries, { path: 'x', mode: '100644', type: 'blob', sha: SHA }]]) {
      const calls = stub({ ...GITHUB, listings: { ...GITHUB.listings, [TREE]: answer(TREE, tree) } })
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'lib' }), new RegExp(`getRepoTreeId: GitHub's listing of tree ${TREE} in acme/app is not that tree$`, 'u'))
      assert.equal(calls.length, 2)
    }
    stub({ ...GITHUB, listings: { [TREE]: { message: 'no tree' } } })
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'lib' }), /is not that tree$/u)
  })

  it('refuses a commit GitHub answers for another sha or without a tree', async () => {
    for (const commit of [{ sha: SUBMODULE_COMMIT, tree: { sha: TREE } }, { sha: SHA }, null]) {
      stub({ ...GITHUB, commits: { [SHA]: commit } })
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA }), new RegExp(`getRepoTreeId: GitHub names no tree for acme/app@${SHA}$`, 'u'))
    }
  })

  it('takes only a full commit sha and a directory inside the repo, before any request', async () => {
    const calls = forbidRequests()
    for (const sha of [undefined, 'main', SHA.slice(0, 7), SHA.toUpperCase()]) {
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha }), /getRepoTreeId: sha must be a full commit sha/u, String(sha))
    }
    for (const directory of ['', '/', '/lib', 'lib/', 'a//b', '.', '..', 'lib/..', '.git', 42]) {
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory }), /getRepoTreeId: directory must be a path inside a repository/u, String(directory))
      await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, path: directory }), /getRepoTreeId: path must be a path inside a repository/u, String(directory))
    }
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'lib', path: 'lib' }), /getRepoTreeId: directory and path are one option, pass directory alone/u)
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, ref: 'main' }), /getRepoTreeId: unknown option ref/u)
    await assert.rejects(client().getRepoTreeId({ repo: 'acme', sha: SHA }), /getRepoTreeId: repo must be "owner\/name"/u)
    assert.deepEqual(calls, [])
  })

  it('throws a HttpError for a commit or a tree GitHub does not have', async () => {
    stub()
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA }), { name: 'HttpError', status: 404, message: `GET ${API}/git/commits/${SHA} 404: {"message":"Not Found"}` })
    stub({ commits: GITHUB.commits })
    await assert.rejects(client().getRepoTreeId({ repo: 'acme/app', sha: SHA, directory: 'lib' }), { name: 'HttpError', status: 404, message: `GET ${API}/git/trees/${TREE} 404: {"message":"Not Found"}` })
  })
})

describe('listRepoDir', () => {
  const entries = (id) => LISTINGS[id].map(({ path, mode, type, sha }) => ({ path, mode, type, sha }))

  it("lists the commit's root without a path, as git has it, with no size or url", async () => {
    const calls = stub(GITHUB)
    assert.deepEqual(await client().listRepoDir({ repo: 'acme/app', sha: SHA }), entries(TREE))
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`, `${API}/git/trees/${TREE}`])
  })

  it('lists a directory, a submodule as the commit it is at', async () => {
    const calls = stub(GITHUB)
    assert.deepEqual(await client().listRepoDir({ repo: 'acme/app', sha: SHA, directory: 'lib' }), entries(TREE_LIB))
    assert.deepEqual(urls(calls), [`${API}/git/commits/${SHA}`, `${API}/git/trees/${TREE}`, `${API}/git/trees/${TREE_LIB}`])
    stub({ ...GITHUB, commits: { [SHA]: { sha: SHA, tree: { sha: SUBMODULE } } } })
    const listed = await client().listRepoDir({ repo: 'acme/app', sha: SHA })
    assert.deepEqual(listed.find(({ path }) => path === 'sub'), { path: 'sub', mode: '160000', type: 'commit', sha: SUBMODULE_COMMIT })
  })

  it("refuses a listing that is not the tree's, cut short included, and a path that is no directory", async () => {
    stub({ ...GITHUB, listings: { ...GITHUB.listings, [TREE_LIB]: { ...answer(TREE_LIB, []), truncated: true } } })
    await assert.rejects(client().listRepoDir({ repo: 'acme/app', sha: SHA, directory: 'lib' }), new RegExp(`listRepoDir: GitHub's listing of tree ${TREE_LIB} in acme/app is not that tree$`, 'u'))
    stub(GITHUB)
    await assert.rejects(client().listRepoDir({ repo: 'acme/app', sha: SHA, directory: 'run' }), new RegExp(`listRepoDir: acme/app@${SHA} has no directory at "run"$`, 'u'))
  })

  it('takes only a full commit sha and a directory inside the repo, before any request', async () => {
    const calls = forbidRequests()
    await assert.rejects(client().listRepoDir({ repo: 'acme/app', sha: 'main' }), /listRepoDir: sha must be a full commit sha/u)
    await assert.rejects(client().listRepoDir({ repo: 'acme/app', sha: SHA, directory: '../x' }), /listRepoDir: directory must be a path inside a repository/u)
    await assert.rejects(client().listRepoDir(), /listRepoDir: options must be an options object/u)
    assert.deepEqual(calls, [])
  })
})
