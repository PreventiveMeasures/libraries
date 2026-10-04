import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'
import { getGitHub, getMeta, getTarball, resolvePackageRepos, verifyDist } from '../npm.js'
import { withNpmToken } from '../src/npm/registry.js'

// NPM_TOKEN goes with every request for a scoped name, and with none for
// an unscoped one. No setCacheDir, and npm's cache and the home directory
// of this file's own, so every answer here is the stub's.
process.env.HOME = join(tmpdir(), `upstream-npm-token-test-${process.pid}`)
process.env.npm_config_cache = join(process.env.HOME, '.npm')
delete process.env.NPM_CONFIG_CACHE

const TOKEN = 'npm_TestToken0123456789'
const BEARER = `Bearer ${TOKEN}`
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x42])
const INTEGRITY = `sha512-${createHash('sha512').update(BYTES).digest('base64')}`
const tarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`

const realFetch = globalThis.fetch

beforeEach(() => {
  process.env.NPM_TOKEN = TOKEN
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.NPM_TOKEN
})

// The registry, where a scoped package is private and answers only with
// the token, as npm's does: its version document, its `latest`, its
// tarball. `calls` is each URL asked for, with the Authorization it came
// with, if any.
function stubRegistry() {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    const auth = init.headers?.Authorization
    calls.push([String(url), auth])
    const [, name, rest] = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\/(.*)$/u.exec(String(url)) ?? []
    if (name?.startsWith('@') && auth !== BEARER) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    if (rest === '1.0.0') return Promise.resolve(Response.json({ name, version: '1.0.0', dist: { tarball: tarballUrl(name, '1.0.0'), integrity: INTEGRITY } }))
    if (rest === 'latest') return Promise.resolve(Response.json({ name, version: '1.0.0', repository: 'github:acme/app' }))
    if (String(url) === tarballUrl(name, '1.0.0')) return Promise.resolve(new Response(BYTES))
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  }
  return calls
}

describe('NPM_TOKEN', () => {
  it("goes with a scoped package's version document and tarball", async () => {
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('@acme/private', '1.0.0')), BYTES)
    assert.deepEqual(calls, [['https://registry.npmjs.org/@acme/private/1.0.0', BEARER], [tarballUrl('@acme/private', '1.0.0'), BEARER]])
    assert.deepEqual(new Uint8Array(await getTarball('@acme/private', '1.0.0', { tarball: tarballUrl('@acme/private', '1.0.0'), integrity: INTEGRITY })), BYTES)
    assert.equal((await getMeta('@acme/private', '1.0.0')).dist.integrity, INTEGRITY)
    await verifyDist('@acme/private', '1.0.0', { tarball: tarballUrl('@acme/private', '1.0.0'), integrity: INTEGRITY })
    assert.ok(calls.every(([, auth]) => auth === BEARER))
  })

  it("goes with a scoped package's `latest`, for its repo", async () => {
    const calls = stubRegistry()
    assert.equal((await getGitHub('@acme/private')).github, 'acme/app')
    const repos = await resolvePackageRepos(['@acme/private', 'lodash'])
    assert.deepEqual([...repos.keys()], ['@acme/private', 'lodash'])
    assert.deepEqual(calls.toSorted(), [
      ['https://registry.npmjs.org/@acme/private/latest', BEARER],
      ['https://registry.npmjs.org/@acme/private/latest', BEARER],
      ['https://registry.npmjs.org/lodash/latest', undefined],
    ])
  })

  it('never goes with an unscoped name', async () => {
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.equal((await getGitHub('lodash')).github, 'acme/app')
    assert.deepEqual(calls, [['https://registry.npmjs.org/pkg/1.0.0', undefined], [tarballUrl('pkg', '1.0.0'), undefined], ['https://registry.npmjs.org/lodash/latest', undefined]])
  })

  it('is not sent where it is unset or empty', async () => {
    for (const token of [undefined, '']) {
      if (token === undefined) delete process.env.NPM_TOKEN
      else process.env.NPM_TOKEN = token
      const calls = stubRegistry()
      await assert.rejects(getTarball('@acme/private', '1.0.0'), { name: 'HttpError', status: 404 })
      assert.deepEqual(calls, [['https://registry.npmjs.org/@acme/private/1.0.0', undefined]])
    }
  })

  it('never goes with the bulk advisories request, which names many packages', async () => {
    const calls = []
    globalThis.fetch = (url, init = {}) => {
      calls.push([String(url), init.headers?.Authorization])
      return Promise.resolve(Response.json({}))
    }
    assert.deepEqual(await advisories([{ ecosystem: 'npm', name: '@acme/private', versions: ['1.0.0'] }]), [])
    assert.deepEqual(calls, [['https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', undefined]])
  })

  it("is only ever for a GET of that name's own URLs on the registry", () => {
    const auth = (name, url, options) => withNpmToken(name, url, options).headers?.Authorization
    assert.equal(auth('@acme/private', 'https://registry.npmjs.org/@acme/private/latest'), BEARER)
    assert.equal(auth('@acme/private', 'https://registry.npmjs.org/@acme/private/-/private-1.0.0.tgz', { method: 'GET', as: 'bytes' }), BEARER)
    assert.equal(auth('pkg', 'https://registry.npmjs.org/pkg/latest'), undefined)
    let reads = 0
    const shifty = { get method() { return reads++ === 0 ? 'GET' : 'POST' } }
    assert.equal(withNpmToken('@acme/private', 'https://registry.npmjs.org/@acme/private/latest', shifty).method, 'GET')
    for (const [name, url, options] of [
      ['@acme/private', 'https://registry.npmjs.org/@acme/private/latest', { method: 'POST' }],
      ['@acme/private', 'https://registry.npmjs.org/@acme/other/latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private-other/latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private'],
      ['@acme/private', 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'],
      ['@acme/private', 'https://evil.example/@acme/private/latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private/../other/latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private/%2e%2e/%2E%2E/@acme/other/latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private/./latest'],
      ['@acme/private', 'https://registry.npmjs.org/@acme/private/..\\..\\@acme/other/latest'],
      ['pkg', 'https://registry.npmjs.org/other/latest'],
    ]) {
      assert.throws(() => withNpmToken(name, url, options), (err) => /Unexpected request for /u.test(err.message) && !err.message.includes(TOKEN), `${options?.method ?? 'GET'} ${url}`)
    }
  })

  it('stays out of an error', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('Unauthorized', { status: 401 }))
    await assert.rejects(getTarball('@acme/private', '1.0.0'), (err) => err.status === 401 && !err.message.includes(TOKEN))
    process.env.NPM_TOKEN = `${TOKEN}\r\nX-Injected: 1`
    await assert.rejects(getTarball('@acme/private', '1.0.0'), (err) => /Unexpected header/u.test(err.message) && !err.message.includes(TOKEN))
  })
})
