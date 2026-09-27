import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { readPackageRepoCache, resolvePackageRepos, setCacheDir, writePackageRepoCache } from '../npm.js'

// A file of its own, because the cache directory is process-wide and
// this is what a process that never calls setCacheDir gets: no cache at
// all, rather than one somewhere nobody chose.

const realFetch = globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
})

function stubRegistry(payloads) {
  const calls = []
  globalThis.fetch = (url) => {
    const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', '').replace(/\/latest$/u, ''))
    calls.push(name)
    const body = payloads[name]
    if (!body) return { ok: false, status: 404, json: () => ({}) }
    return { ok: true, status: 200, json: () => ({ name, ...body }) }
  }
  return calls
}

describe('without setCacheDir', () => {
  it('reads nothing and writes nothing', async () => {
    assert.equal(await writePackageRepoCache('lodash', 'lodash/lodash'), false)
    assert.equal(await readPackageRepoCache('lodash'), null)
  })

  it('asks the registry every time', async () => {
    const calls = stubRegistry({ lodash: { repository: 'lodash/lodash' } })
    const names = new Set(['lodash'])
    assert.deepEqual([...await resolvePackageRepos(names)], [['lodash', { github: 'lodash/lodash' }]])
    assert.deepEqual([...await resolvePackageRepos(names)], [['lodash', { github: 'lodash/lodash' }]])
    assert.deepEqual(calls, ['lodash', 'lodash'])
  })

  it('answers nothing under cachedOnly', async () => {
    globalThis.fetch = undefined
    assert.deepEqual([...await resolvePackageRepos(new Set(['lodash']), { cachedOnly: true })], [])
  })

  it('refuses a directory that is not one, and stays without a cache', async () => {
    assert.throws(() => setCacheDir(''))
    assert.throws(() => setCacheDir(undefined))
    assert.equal(await writePackageRepoCache('lodash', 'lodash/lodash'), false)
  })
})
