import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { getTarball, readPackageRepoCache, resolvePackageRepos, setCacheDir, writePackageRepoCache } from '../npm.js'

// A file of its own, because the cache directory is process-wide and
// this is what a process that never calls setCacheDir gets: no cache to
// write, rather than one somewhere nobody chose, and none to read but ours
// for tarballs (cache-dir.test.js).

// And other tools' caches with nothing in them, as getTarball reads those
// first: a home directory and an npm cache that do not exist.
process.env.HOME = join(tmpdir(), `upstream-npm-no-cache-test-${process.pid}`)
process.env.npm_config_cache = join(process.env.HOME, '.npm')
delete process.env.NPM_CONFIG_CACHE

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
    if (!body) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    return Promise.resolve(Response.json({ name, ...body }))
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

  it('fetches a tarball every time, still checked', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      if (String(url).endsWith('.tgz')) return Promise.resolve(new Response(bytes))
      return Promise.resolve(Response.json({ name: 'pkg', version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz', integrity } }))
    }
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), bytes)
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), bytes)
    assert.equal(calls.length, 4)
  })

  it('refuses a directory that is not one, and stays without a cache', async () => {
    assert.throws(() => setCacheDir(''))
    assert.throws(() => setCacheDir(null))
    assert.equal(await writePackageRepoCache('lodash', 'lodash/lodash'), false)
    setCacheDir(false)
    assert.equal(await writePackageRepoCache('lodash', 'lodash/lodash'), false)
  })
})
