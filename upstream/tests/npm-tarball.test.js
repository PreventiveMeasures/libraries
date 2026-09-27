import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { getTarball, setCacheDir } from '../npm.js'

// A cache directory of this file's own: everything below is a real disk
// read or write, and it has to land somewhere nothing else reads.
const CACHE_DIR = join(tmpdir(), `upstream-npm-tarball-test-${process.pid}`)
setCacheDir(CACHE_DIR)

const TARBALLS = join(CACHE_DIR, 'npm', 'tarballs')

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
})

// Not valid UTF-8, so bytes that went through a string anywhere would
// come back different.
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x42])
const sri = (bytes, algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
const tarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`

// The registry, for one version of one package: its version document,
// with `dist` as given, and its tarball as `served`. `calls` is every
// URL asked for.
function stubRegistry({ name = 'pkg', version = '1.0.0', dist = {}, served = BYTES } = {}) {
  const calls = []
  const tarball = tarballUrl(name, version)
  globalThis.fetch = (url) => {
    calls.push(String(url))
    if (String(url) === `https://registry.npmjs.org/${name}/${version}`) {
      return Promise.resolve(Response.json({ name, version, dist: { tarball, integrity: sri(BYTES), ...dist } }))
    }
    if (String(url) === (dist.tarball ?? tarball)) return Promise.resolve(new Response(served))
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  }
  return calls
}

describe('getTarball', () => {
  it('fetches the version document, then its tarball, bytes intact', async () => {
    const calls = stubRegistry()
    const bytes = await getTarball('pkg', '1.0.0')
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), BYTES)
    assert.deepEqual(calls, ['https://registry.npmjs.org/pkg/1.0.0', tarballUrl('pkg', '1.0.0')])
  })

  it('refuses bytes that do not match the integrity, and caches nothing', async () => {
    stubRegistry({ served: new Uint8Array([...BYTES, 0]) })
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from https:\/\/registry\.npmjs\.org\/pkg\/-\/pkg-1\.0\.0\.tgz/u)
    assert.deepEqual(await readdir(TARBALLS).catch(() => []), [])
  })

  it("takes the tarball URL only where it is exactly this version's on the registry", async () => {
    for (const tarball of [
      'https://evil.example/pkg/-/pkg-1.0.0.tgz',
      'https://registry.npmjs.org.evil.example/pkg/-/pkg-1.0.0.tgz',
      'http://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      'https://registry.npmjs.org/other/-/other-1.0.0.tgz',
      'https://registry.npmjs.org/pkg/-/pkg-1.0.1.tgz',
      'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz?x',
      'https://registry.npmjs.org/pkg/-/../../other/-/other-1.0.0.tgz',
      undefined,
    ]) {
      const calls = stubRegistry({ dist: { tarball } })
      await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: unexpected tarball URL/u, tarball)
      assert.deepEqual(calls, ['https://registry.npmjs.org/pkg/1.0.0'])
    }
  })

  it("takes a scoped package's tarball, filed under the name without its scope", async () => {
    const calls = stubRegistry({ name: '@scope/pkg' })
    assert.deepEqual(new Uint8Array(await getTarball('@scope/pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, ['https://registry.npmjs.org/@scope/pkg/1.0.0', 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz'])
  })

  it('needs a sha512 integrity, and takes any one of several', async () => {
    stubRegistry({ dist: { integrity: undefined } })
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: no integrity for pkg@1\.0\.0/u)
    stubRegistry({ dist: { integrity: sri(BYTES, 'sha1') } })
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: no sha512 integrity/u)
    stubRegistry({ dist: { integrity: `${sri(BYTES, 'sha1')} ${sri(new Uint8Array([1]))} ${sri(BYTES)}?opt` } })
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
  })


  it('throws on a version the registry does not have', async () => {
    stubRegistry()
    await assert.rejects(getTarball('pkg', '9.9.9'), { name: 'HttpError', status: 404, message: 'GET https://registry.npmjs.org/pkg/9.9.9 404: {"error":"Not found"}' })
  })
})

describe('the tarball cache', () => {
  it('serves the next call from disk, checked, without a request', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    globalThis.fetch = undefined
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
  })

  it('files the bytes with the integrity they were checked against, a scoped name in one file', async () => {
    stubRegistry({ name: '@scope/pkg' })
    await getTarball('@scope/pkg', '1.0.0')
    assert.deepEqual((await readdir(TARBALLS)).toSorted(), ['%40scope%2Fpkg%401.0.0.json', '%40scope%2Fpkg%401.0.0.tgz'])
    assert.deepEqual(new Uint8Array(await readFile(join(TARBALLS, '%40scope%2Fpkg%401.0.0.tgz'))), BYTES)
    assert.deepEqual(JSON.parse(await readFile(join(TARBALLS, '%40scope%2Fpkg%401.0.0.json'), 'utf8')), { name: '@scope/pkg', version: '1.0.0', integrity: sri(BYTES) })
  })

  it('throws on cached bytes that no longer match, rather than fetching over them', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    await writeFile(join(TARBALLS, 'pkg%401.0.0.tgz'), new Uint8Array([...BYTES, 0]))
    const calls = stubRegistry()
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [])
  })

  it('misses on half an entry, or a record it did not write, and fetches again', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    const json = join(TARBALLS, 'pkg%401.0.0.json')
    const tgz = join(TARBALLS, 'pkg%401.0.0.tgz')

    for (const damage of [
      () => rm(json),
      () => rm(tgz),
      () => writeFile(json, '{"name":"pkg","vers'),
      () => writeFile(json, JSON.stringify({ name: 'other', version: '1.0.0', integrity: sri(BYTES) })),
      () => writeFile(json, JSON.stringify({ name: 'pkg', version: '1.0.0' })),
    ]) {
      await damage()
      const calls = stubRegistry()
      assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
      assert.equal(calls.length, 2)
      // And the fetch put a whole entry back.
      globalThis.fetch = undefined
      assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    }
  })
})
