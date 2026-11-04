import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '../github.js'
import { objectId } from '../src/tree.js'
import { SHA, SHA2, deepOf, forbidRequests, json, stubGitHub, stubTrees, treeOf } from './github-stub.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const API = 'https://api.github.com/repos/acme/app'
const blob = (text, mode = '100644') => ({ mode, type: 'blob', sha: objectId('blob', Buffer.from(text)).toString('hex') })
const list = (options) => createClient({ token: 't0ken' }).listRepoTree({ repo: 'acme/app', sha: SHA, ...options })
const urls = (calls) => calls.map(({ url }) => url.slice(API.length))
const byPath = (a, b) => (a.path < b.path ? -1 : 1)
const sorted = (entries) => entries.toSorted(byPath)

// Each kind of entry: a file, an executable, a symlink, a submodule, an
// installed package, and directories, nested.
const REPO = treeOf({
  'package.json': blob('{}\n'),
  'bin/run': blob('#!/bin/sh\n', '100755'),
  'link': blob('package.json', '120000'),
  'sub': { mode: '160000', type: 'commit', sha: SHA2 },
  'apps/web/package.json': blob('{"name":"web"}\n'),
  'apps/web/node_modules/left-pad/index.js': blob('module.exports = 1\n'),
  'apps/cli/index.js': blob('#!/usr/bin/env node\n'),
  'docs/a.md': blob('# a\n'),
})
const DEEP = deepOf(REPO.listings, REPO.tree).map(({ path, mode, type, sha }) => ({ path, mode, type, sha }))
const at = (path) => DEEP.find((entry) => entry.path === path).sha
const under = (...dirs) => DEEP.filter(({ path }) => path.includes('/') && dirs.includes(path.slice(0, path.lastIndexOf('/'))))
const OWN = DEEP.filter(({ path }) => !path.includes('/'))

describe('listRepoTree', () => {
  it("is the commit's tree in one listing, every entry by its path, as git has it", async () => {
    const calls = stubTrees(REPO)
    assert.deepEqual(await list(), { entries: DEEP, cut: false })
    assert.deepEqual(urls(calls), [`/git/commits/${SHA}`, `/git/trees/${REPO.tree}?recursive=1`])
    assert.deepEqual(await list({ paths: [] }), { entries: DEEP, cut: false })
  })

  it('lists a tree GitHub cuts short by its own listing, then each tree in it the same way', async () => {
    const calls = stubTrees(REPO, { truncated: [REPO.tree, at('apps')] })
    const { entries, cut } = await list()
    assert.deepEqual(sorted(entries), sorted(DEEP))
    assert.equal(cut, false)
    assert.deepEqual(urls(calls).slice(0, 3), [`/git/commits/${SHA}`, `/git/trees/${REPO.tree}?recursive=1`, `/git/trees/${REPO.tree}`])
    assert.deepEqual(urls(calls).slice(3).toSorted(), [
      ...['apps', 'bin', 'docs'].map((path) => `/git/trees/${at(path)}?recursive=1`), `/git/trees/${at('apps')}`,
      ...['apps/cli', 'apps/web'].map((path) => `/git/trees/${at(path)}?recursive=1`),
    ].toSorted())
  })

  it('goes into only the trees `paths` are in where GitHub cuts the listing short', async () => {
    stubTrees(REPO, { truncated: [REPO.tree, at('apps')] })
    const { entries, cut } = await list({ paths: ['apps/web/package.json', 'README.md'] })
    assert.deepEqual(sorted(entries), sorted([...OWN, ...under('apps'), ...DEEP.filter(({ path }) => path.startsWith('apps/web/'))]))
    assert.equal(cut, false)
    stubTrees(REPO, { truncated: [REPO.tree] })
    assert.deepEqual(await list({ paths: [] }), { entries: OWN, cut: false })
    stubTrees(REPO, { truncated: [REPO.tree] })
    assert.deepEqual(sorted((await list({ paths: ['docs/a.md', 'docs/b/c.md'] })).entries), sorted([...OWN, ...under('docs')]))
  })

  it('lists `maxTrees` trees at most, and tells it left the rest out', async () => {
    stubTrees(REPO, { truncated: [REPO.tree] })
    assert.deepEqual(await list({ maxTrees: 1 }), { entries: OWN, cut: true })
    stubTrees(REPO, { truncated: [REPO.tree] })
    const { entries, cut } = await list({ maxTrees: 3 })
    assert.deepEqual(sorted(entries), sorted(DEEP.filter(({ path }) => !path.startsWith('docs/'))))
    assert.equal(cut, true)
    stubTrees(REPO, { truncated: [REPO.tree] })
    assert.equal((await list({ maxTrees: 4 })).cut, false)
    stubTrees(REPO)
    assert.deepEqual(await list({ maxTrees: 1 }), { entries: DEEP, cut: false })
  })

  it('asks for six trees at once', async () => {
    const wide = treeOf(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}/f`, blob(`${i}\n`)])))
    stubTrees(wide, { truncated: [wide.tree] })
    const answer = globalThis.fetch
    let now = 0
    let most = 0
    globalThis.fetch = async (...args) => {
      most = Math.max(most, ++now)
      await delay(5)
      now--
      return answer(...args)
    }
    assert.equal((await list()).entries.length, 20)
    assert.equal(most, 6)
  })

  it("refuses a listing that is not the tree's, whole or cut short, the top one's or one under it", async () => {
    const changed = deepOf(REPO.listings, REPO.tree).map((entry) => (entry.path === 'docs/a.md' ? { ...entry, sha: SHA } : entry))
    stubTrees(REPO, { deep: { [REPO.tree]: changed } })
    await assert.rejects(list(), new RegExp(`^AssertionError.*listRepoTree: GitHub's listing of tree ${REPO.tree} in acme/app, with the trees under it, is not that tree$`, 'u'))
    stubTrees({ ...REPO, listings: { ...REPO.listings, [REPO.tree]: REPO.listings[REPO.tree].slice(1) } }, { truncated: [REPO.tree] })
    await assert.rejects(list(), new RegExp(`listRepoTree: GitHub's listing of tree ${REPO.tree} in acme/app is not that tree$`, 'u'))
    stubTrees({ ...REPO, listings: { ...REPO.listings, [at('apps')]: [] } }, { truncated: [REPO.tree, at('apps')] })
    await assert.rejects(list(), new RegExp(`listRepoTree: GitHub's listing of tree ${at('apps')} in acme/app is not that tree$`, 'u'))
  })

  it('takes only a full commit sha, paths inside the repo and a positive count of trees, before any request', async () => {
    const calls = forbidRequests()
    for (const sha of [undefined, 'main', SHA.slice(0, 7)]) await assert.rejects(list({ sha }), /listRepoTree: sha must be a full commit sha/u, String(sha))
    for (const paths of ['a/b', [''], ['/a'], ['a/../b'], ['.git/config'], [42], new Set(['a'])]) {
      await assert.rejects(list({ paths }), /listRepoTree: paths must be an array of paths inside a repository/u, String(paths))
    }
    for (const maxTrees of [0, -1, 1.5, '6']) await assert.rejects(list({ maxTrees }), /listRepoTree: maxTrees must be a positive integer/u, String(maxTrees))
    await assert.rejects(list({ directory: 'apps' }), /listRepoTree: unknown option directory/u)
    await assert.rejects(createClient({ token: 't0ken' }).listRepoTree(), /listRepoTree: options must be an options object/u)
    assert.deepEqual(calls, [])
  })

  it('throws a HttpError for a commit or a tree GitHub does not have', async () => {
    stubTrees({ tree: REPO.tree, listings: {} })
    await assert.rejects(list(), { name: 'HttpError', status: 404, message: `GET ${API}/git/trees/${REPO.tree}?recursive=1 404: {"message":"Not Found"}` })
    stubGitHub(() => json({ message: 'Not Found' }, 404))
    await assert.rejects(list(), { name: 'HttpError', status: 404, message: `GET ${API}/git/commits/${SHA} 404: {"message":"Not Found"}` })
  })
})
