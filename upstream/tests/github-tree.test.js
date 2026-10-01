import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { forbidRequests, stubGitHub } from './github-stub.js'
import { SUBMODULE, SUBMODULE_TGZ, TREE, TREE_TGZ } from './tree-fixtures.js'

const CACHE_DIR = join(tmpdir(), `upstream-github-tree-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const TREES = join(CACHE_DIR, 'github', 'trees')

const realFetch = globalThis.fetch
const client = () => createClient({ token: 't0ken' })
const serve = (bytes) => stubGitHub(() => new Response(bytes, { headers: { 'content-type': 'application/x-gzip' } }))
const URL = `https://api.github.com/repos/acme/app/tarball/${TREE}`

beforeEach(() => rm(CACHE_DIR, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => rm(CACHE_DIR, { recursive: true, force: true }))

describe('getRepoTreeTarball', () => {
  it('fetches the tarball of a tree by its id, following the redirect, and holds it to the id', async () => {
    const calls = serve(TREE_TGZ)
    const bytes = await client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE })
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(Buffer.from(bytes), TREE_TGZ)
    assert.deepEqual(calls.map(({ url, redirect, headers }) => [url, redirect, headers.Authorization]), [[URL, 'follow', 'Bearer t0ken']])
  })

  it('refuses the tarball of another tree, or of this one changed, and caches nothing', async () => {
    const tar = Buffer.from(gunzipSync(TREE_TGZ))
    tar.write('export []', tar.indexOf('export {}'), 'latin1')
    for (const [tree, served] of [[SUBMODULE, TREE_TGZ], [TREE, gzipSync(tar)]]) {
      serve(served)
      await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree }), new RegExp(`getRepoTreeTarball: integrity mismatch for ${tree} from https://api\\.github\\.com/repos/acme/app/tarball/${tree}: expected ${tree}, got [\\da-f]{40}$`, 'u'))
    }
    assert.deepEqual(await readdir(TREES).catch(() => []), [])
  })

  it('refuses a tree with a submodule, which its tarball cannot show', async () => {
    serve(SUBMODULE_TGZ)
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: SUBMODULE }), /got no tree: an empty directory, as a submodule is written$/u)
  })

  it('keeps it by the tree id alone, serving it again with no request, and throws on cached bytes that no longer match', async () => {
    serve(TREE_TGZ)
    await client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE })
    assert.deepEqual(await readdir(TREES), [`${TREE}.tgz`])
    assert.deepEqual(await readFile(join(TREES, `${TREE}.tgz`)), TREE_TGZ)
    const calls = forbidRequests()
    assert.deepEqual(Buffer.from(await client().getRepoTreeTarball({ repo: 'acme/fork', tree: TREE })), TREE_TGZ)
    await writeFile(join(TREES, `${TREE}.tgz`), SUBMODULE_TGZ)
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
    stubGitHub(() => new Response('{"message":"Not Found"}', { status: 404 }))
    await assert.rejects(client().getRepoTreeTarball({ repo: 'acme/app', tree: TREE }), { name: 'HttpError', status: 404, message: `GET ${URL} 404: {"message":"Not Found"}` })
  })
})
