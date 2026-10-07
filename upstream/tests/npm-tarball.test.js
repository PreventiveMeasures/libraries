import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { getMeta, getPublishTimes, getTarball, setCacheDir, verifyDist } from '../npm.js'
import { mapStore } from './cache-store.js'

// A cache directory of this file's own: everything below is a real disk
// read or write, and it has to land somewhere nothing else reads.
const CACHE_DIR = join(tmpdir(), `upstream-npm-tarball-test-${process.pid}`)
setCacheDir(CACHE_DIR)

const TARBALLS = join(CACHE_DIR, 'npm', 'tarballs')
const VERSIONS = join(CACHE_DIR, 'npm', 'versions')

// npm's cache and the home directory, where getTarball looks first: this
// file's own too, so no tarball on this machine answers for the stubs.
const LOCAL = join(tmpdir(), `upstream-npm-local-test-${process.pid}`)
const HOME = join(LOCAL, 'home')
const NPM_CACHE = join(LOCAL, 'npm-cache')
process.env.HOME = HOME
process.env.npm_config_cache = NPM_CACHE
delete process.env.NPM_CONFIG_CACHE

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(LOCAL, { recursive: true, force: true })
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(LOCAL, { recursive: true, force: true })
})

// Not valid UTF-8, so bytes that went through a string anywhere would
// come back different.
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x42])
const sri = (bytes, algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
const tarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
// pkg@1.0.0: its version document's URL, its dist, and an integrity it has not.
const DOC = 'https://registry.npmjs.org/pkg/1.0.0'
const DIST = { tarball: tarballUrl('pkg', '1.0.0'), integrity: sri(BYTES) }
const OTHER = sri(new Uint8Array([1]))

// Where cacache files bytes: by their sha512, in hex.
const contentPath = (root, bytes) => {
  const hex = createHash('sha512').update(bytes).digest('hex')
  return join(root, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}
const plant = async (path, bytes) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

// The registry, for one version of one package: its version document,
// with `dist` as given and `fields` beside it, and its tarball as
// `served`. `calls` is every URL asked for.
function stubRegistry({ name = 'pkg', version = '1.0.0', dist = {}, fields = {}, served = BYTES } = {}) {
  const calls = []
  const tarball = tarballUrl(name, version)
  globalThis.fetch = (url) => {
    calls.push(String(url))
    if (String(url) === `https://registry.npmjs.org/${name}/${version}`) {
      return Promise.resolve(Response.json({ name, version, ...fields, dist: { tarball, integrity: sri(BYTES), ...dist } }))
    }
    if (String(url) === (dist.tarball ?? tarball)) return Promise.resolve(new Response(served))
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  }
  return calls
}

// No registry at all: every request refused, and `calls` every URL asked.
function offline() {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.reject(new Error(`unexpected request: ${url}`))
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
      await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: dist\.tarball must be https:\/\/registry\.npmjs\.org\/pkg\/-\/pkg-1\.0\.0\.tgz, got/u, tarball)
      assert.deepEqual(calls, ['https://registry.npmjs.org/pkg/1.0.0'])
    }
  })

  it("takes a scoped package's tarball, filed under the name without its scope", async () => {
    const calls = stubRegistry({ name: '@scope/pkg' })
    assert.deepEqual(new Uint8Array(await getTarball('@scope/pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, ['https://registry.npmjs.org/@scope/pkg/1.0.0', 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz'])
  })

  it('needs exactly one sha512 as the integrity, as the registry writes it', async () => {
    for (const integrity of [undefined, sri(BYTES, 'sha1'), `${sri(BYTES, 'sha1')} ${sri(BYTES)}`, `${sri(BYTES)} ${sri(BYTES)}`, `${sri(BYTES)}?opt`, ` ${sri(BYTES)}`, sri(BYTES).replace('sha512', 'SHA512')]) {
      const calls = stubRegistry({ dist: { integrity } })
      await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: dist\.integrity must be "sha512-" and a base64 sha512/u, String(integrity))
      assert.deepEqual(calls, ['https://registry.npmjs.org/pkg/1.0.0'])
    }
  })

  it('throws on a version the registry does not have', async () => {
    stubRegistry()
    await assert.rejects(getTarball('pkg', '9.9.9'), { name: 'HttpError', status: 404, message: 'GET https://registry.npmjs.org/pkg/9.9.9 404: {"error":"Not found"}' })
  })
})

describe('the tarball cache', () => {

  it('serves the bytes of the next call from disk, still checked against the registry', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC])
  })

  it('files only the bytes, a scoped name in one file', async () => {
    stubRegistry({ name: '@scope/pkg' })
    await getTarball('@scope/pkg', '1.0.0')
    assert.deepEqual(await readdir(TARBALLS), ['@scope+pkg@1.0.0.tgz'])
    assert.deepEqual(new Uint8Array(await readFile(join(TARBALLS, '@scope+pkg@1.0.0.tgz'))), BYTES)
  })

  it('throws on cached bytes that no longer match, rather than fetching over them', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    await writeFile(join(TARBALLS, 'pkg@1.0.0.tgz'), new Uint8Array([...BYTES, 0]))
    const calls = stubRegistry()
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [DOC])
  })

  it('takes nothing the cache says about its own bytes', async () => {
    const evil = new Uint8Array([0x1f, 0x8b, 0x66, 0x66])
    await mkdir(TARBALLS, { recursive: true })
    await writeFile(join(TARBALLS, 'pkg@1.0.0.tgz'), evil)
    await writeFile(join(TARBALLS, 'pkg@1.0.0.json'), JSON.stringify({ name: 'pkg', version: '1.0.0', integrity: sri(evil) }))
    stubRegistry()
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from the cache/u)
    globalThis.fetch = () => Promise.reject(new Error('offline'))
    await assert.rejects(getTarball('pkg', '1.0.0'), /offline/u)
  })

  it('fetches again where the bytes are gone, and files them again', async () => {
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    await rm(join(TARBALLS, 'pkg@1.0.0.tgz'))
    let calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.equal(calls.length, 2)
    calls = stubRegistry()
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(calls, [DOC])
  })
})

describe('the version document cache', () => {
  const FILE = join(VERSIONS, 'pkg@1.0.0.json.gz')
  const FIELDS = { description: 'A package', dependencies: { dep: '^1.0.0' }, _npmUser: { name: 'someone' } }
  const WHOLE = { name: 'pkg', version: '1.0.0', ...FIELDS, dist: { ...DIST, shasum: 'abc', fileCount: 3 } }
  const serveWhole = () => stubRegistry({ fields: FIELDS, dist: { shasum: 'abc', fileCount: 3 } })
  const keep = async (bytes) => {
    await mkdir(VERSIONS, { recursive: true })
    await writeFile(FILE, bytes)
  }
  const compress = (value) => gzipSync(JSON.stringify(value))

  it('keeps the whole document, compressed, from getMeta and getTarball, which ask every time', async () => {
    let calls = serveWhole()
    assert.deepEqual(await getMeta('pkg', '1.0.0'), { name: 'pkg', version: '1.0.0', dist: DIST })
    assert.deepEqual(await readdir(VERSIONS), ['pkg@1.0.0.json.gz'])
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE)
    await getMeta('pkg', '1.0.0')
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(calls, [DOC, DOC, DOC, tarballUrl('pkg', '1.0.0')])
    calls = serveWhole()
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(calls, [DOC])
    await rm(CACHE_DIR, { recursive: true, force: true })
    serveWhole()
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE)
  })

  it('files a scoped name in one file, and each version in its own', async () => {
    stubRegistry({ name: '@scope/pkg' })
    await getMeta('@scope/pkg', '1.0.0')
    stubRegistry({ version: '2.0.0-RC.1' })
    await getMeta('pkg', '2.0.0-RC.1')
    assert.deepEqual((await readdir(VERSIONS)).toSorted(), ['@scope+pkg@1.0.0.json.gz', 'pkg@2.0.0-!r!c.1.json.gz'])
  })

  it('confirms the integrity verifyDist is given, with no request', async () => {
    serveWhole()
    await getMeta('pkg', '1.0.0')
    const calls = offline()
    await verifyDist('pkg', '1.0.0', DIST)
    assert.deepEqual(calls, [])
  })

  it("asks the registry where the integrity given is not the one kept, and throws on the registry's", async () => {
    serveWhole()
    await getMeta('pkg', '1.0.0')
    const calls = serveWhole()
    await assert.rejects(verifyDist('pkg', '1.0.0', { ...DIST, integrity: OTHER }), (err) => err.message === `verifyDist: pkg@1.0.0 is ${sri(BYTES)} on the registry, not ${OTHER}`)
    assert.deepEqual(calls, [DOC])
  })

  it('answers getMeta given a dist from the document kept, with no request', async () => {
    stubRegistry({ fields: { ...FIELDS, gitHead: 'a'.repeat(40), homepage: 'https://example.com/pkg' }, dist: { shasum: 'abc', fileCount: 3 } })
    const meta = await getMeta('pkg', '1.0.0')
    const calls = offline()
    assert.deepEqual(await getMeta('pkg', '1.0.0', { dist: DIST }), meta)
    assert.deepEqual(calls, [])
  })

  it('fetches and keeps the document for getMeta given a dist where none is kept, then answers from it', async () => {
    let calls = serveWhole()
    assert.deepEqual((await getMeta('pkg', '1.0.0', { dist: DIST })).dist, DIST)
    assert.deepEqual(calls, [DOC])
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE)
    calls = offline()
    await getMeta('pkg', '1.0.0', { dist: DIST })
    assert.deepEqual(calls, [])
  })

  it('passes over a kept document whose dist is not the one getMeta is given, keeping the registry\'s, which throws where it is not either', async () => {
    const evil = new Uint8Array([0x1f, 0x8b, 0x66, 0x66])
    await keep(compress({ ...WHOLE, dist: { ...WHOLE.dist, integrity: sri(evil) } }))
    let calls = serveWhole()
    assert.deepEqual((await getMeta('pkg', '1.0.0', { dist: DIST })).dist, DIST)
    assert.deepEqual(calls, [DOC])
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE, 'the registry\'s kept in its place')
    calls = serveWhole()
    await assert.rejects(getMeta('pkg', '1.0.0', { dist: { ...DIST, integrity: OTHER } }), (err) => err.message === `getMeta: pkg@1.0.0 is ${sri(BYTES)} on the registry, not ${OTHER}`)
    assert.deepEqual(calls, [DOC])
  })

  it("keeps the registry's document where it has another integrity, and throws", async () => {
    const calls = serveWhole()
    await assert.rejects(verifyDist('pkg', '1.0.0', { ...DIST, integrity: OTHER }), (err) => err.message === `verifyDist: pkg@1.0.0 is ${sri(BYTES)} on the registry, not ${OTHER}`)
    assert.deepEqual(calls, [DOC])
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE)
  })

  it('supplies no integrity: getMeta and getTarball pass over a document kept with another', async () => {
    const evil = new Uint8Array([0x1f, 0x8b, 0x66, 0x66])
    await keep(compress({ ...WHOLE, dist: { ...DIST, integrity: sri(evil) } }))
    await mkdir(TARBALLS, { recursive: true })
    await writeFile(join(TARBALLS, 'pkg@1.0.0.tgz'), evil)
    const calls = serveWhole()
    assert.equal((await getMeta('pkg', '1.0.0')).dist.integrity, sri(BYTES))
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [DOC, DOC])
  })

  it('asks the registry in place of one not compressed, cut short, damaged, for another version, or refused', async () => {
    // Its CRC-32 a bit off: what decodes is the document as it was.
    const damaged = compress(WHOLE)
    damaged[damaged.length - 8] ^= 1
    for (const [i, kept] of [
      JSON.stringify(WHOLE),
      compress(WHOLE).subarray(0, 20),
      damaged,
      compress(null),
      compress([WHOLE]),
      compress({ ...WHOLE, name: 'other' }),
      compress({ ...WHOLE, version: '1.0.1' }),
      compress({ ...WHOLE, dist: { ...WHOLE.dist, tarball: 'https://evil.example/pkg/-/pkg-1.0.0.tgz' } }),
      compress({ ...WHOLE, dist: { ...WHOLE.dist, integrity: `${DIST.integrity} ${DIST.integrity}` } }),
    ].entries()) {
      await keep(kept)
      const calls = serveWhole()
      await verifyDist('pkg', '1.0.0', DIST)
      assert.deepEqual(calls, [DOC], String(i))
      assert.deepEqual(JSON.parse(gunzipSync(await readFile(FILE))), WHOLE, String(i))
    }
  })

  it('keeps none the registry does not have, answers for another version, or with a dist refused', async () => {
    stubRegistry()
    await assert.rejects(getMeta('pkg', '9.9.9'), { name: 'HttpError', status: 404 })
    globalThis.fetch = () => Promise.resolve(Response.json({ name: 'pkg', version: '1.0.1', dist: DIST }))
    await assert.rejects(getMeta('pkg', '1.0.0'), /getMeta: the registry answered for .*1\.0\.1.*, not pkg@1\.0\.0/u)
    stubRegistry({ dist: { integrity: sri(BYTES, 'sha1') } })
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: dist\.integrity must be/u)
    stubRegistry({ dist: { tarball: 'https://evil.example/pkg/-/pkg-1.0.0.tgz' } })
    await assert.rejects(verifyDist('pkg', '1.0.0', DIST), /verifyDist: dist\.tarball must be/u)
    assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
  })

  it('is read and written nowhere with no cache set', async () => {
    setCacheDir(false)
    try {
      const calls = stubRegistry()
      await getMeta('pkg', '1.0.0')
      await verifyDist('pkg', '1.0.0', DIST)
      assert.deepEqual(calls, [DOC, DOC])
      assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
    } finally {
      setCacheDir(CACHE_DIR)
    }
  })
})

describe("a caller's store, and cache false", () => {
  const TGZ = tarballUrl('pkg', '1.0.0')
  const DOCUMENT = { name: 'pkg', version: '1.0.0', dist: DIST }
  // Bytes kept as bytes.
  const byteStore = () => mapStore(structuredClone)

  it('keeps version documents and tarballs in the store, by type and name@version, and nothing on disk', async () => {
    const store = byteStore()
    let calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', undefined, { cache: store })), BYTES)
    assert.deepEqual(calls, [DOC, TGZ])
    assert.deepEqual(store.log, [['write', 'npm/versions', 'pkg@1.0.0'], ['read', 'npm/tarballs', 'pkg@1.0.0'], ['write', 'npm/tarballs', 'pkg@1.0.0']])
    assert.deepEqual(store.get('npm/versions', 'pkg@1.0.0'), DOCUMENT)
    assert.deepEqual(new Uint8Array(store.get('npm/tarballs', 'pkg@1.0.0')), BYTES)
    calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', undefined, { cache: store })), BYTES)
    assert.deepEqual(calls, [DOC])
    calls = offline()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', DIST, { cache: store })), BYTES)
    await verifyDist('pkg', '1.0.0', DIST, { cache: store })
    assert.deepEqual(calls, [])
    calls = stubRegistry()
    await assert.rejects(verifyDist('pkg', '1.0.0', { ...DIST, integrity: OTHER }, { cache: store }), (err) => err.message === `verifyDist: pkg@1.0.0 is ${sri(BYTES)} on the registry, not ${OTHER}`)
    assert.deepEqual(calls, [DOC])
    store.log.length = 0
    stubRegistry()
    await getMeta('pkg', '1.0.0', { cache: store })
    assert.deepEqual(store.log, [['write', 'npm/versions', 'pkg@1.0.0']], 'getMeta reads no document')
    assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
  })

  it('throws on bytes in the store that do not match, and takes what is not bytes, or a document refused, as a miss', async () => {
    const store = byteStore()
    store.set('npm/tarballs', 'pkg@1.0.0', new Uint8Array([...BYTES, 0]))
    stubRegistry()
    await assert.rejects(getTarball('pkg', '1.0.0', DIST, { cache: store }), /getTarball: integrity mismatch for pkg@1\.0\.0 from the store/u)
    for (const kept of [undefined, null, 'bytes', [...BYTES], { 0: 0x1f }]) {
      store.set('npm/tarballs', 'pkg@1.0.0', kept)
      const calls = stubRegistry()
      assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', DIST, { cache: store })), BYTES, String(kept))
      assert.deepEqual(calls, [TGZ])
      assert.deepEqual(new Uint8Array(store.get('npm/tarballs', 'pkg@1.0.0')), BYTES)
    }
    for (const kept of [null, 'text', { ...DOCUMENT, version: '1.0.1' }, { ...DOCUMENT, dist: { ...DIST, tarball: 'https://evil.example/pkg-1.0.0.tgz' } }]) {
      store.set('npm/versions', 'pkg@1.0.0', kept)
      const calls = stubRegistry()
      await verifyDist('pkg', '1.0.0', DIST, { cache: store })
      assert.deepEqual(calls, [DOC], JSON.stringify(kept))
      assert.deepEqual(store.get('npm/versions', 'pkg@1.0.0'), DOCUMENT)
    }
  })

  it('shares no bytes with the store, either way', async () => {
    const entries = new Map()
    const keeping = { read: (type, key) => Promise.resolve(entries.get(key)), write: (type, key, value) => Promise.resolve(void entries.set(key, value)) }
    stubRegistry()
    const fetched = await getTarball('pkg', '1.0.0', DIST, { cache: keeping })
    fetched.fill(0)
    assert.deepEqual(new Uint8Array(entries.get('pkg@1.0.0')), BYTES)
    entries.set('pkg@1.0.0', Buffer.from(BYTES))
    const kept = await getTarball('pkg', '1.0.0', DIST, { cache: keeping })
    kept.fill(0)
    assert.deepEqual(new Uint8Array(entries.get('pkg@1.0.0')), BYTES)
    entries.get('pkg@1.0.0').fill(0)
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', DIST, { cache: { ...keeping, read: () => Promise.resolve(Buffer.from(BYTES)) } })), BYTES)
  })

  it("reads other tools' caches and ours before the store", async () => {
    await plant(contentPath(NPM_CACHE, BYTES), BYTES)
    const store = byteStore()
    const calls = offline()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', DIST, { cache: store })), BYTES)
    assert.deepEqual([calls, store.log], [[], []])
  })

  it('answers getMeta given a dist from the store, writing nothing', async () => {
    const store = byteStore()
    stubRegistry()
    await getMeta('pkg', '1.0.0', { cache: store })
    store.log.length = 0
    const calls = offline()
    assert.deepEqual((await getMeta('pkg', '1.0.0', { dist: DIST, cache: store })).dist, DIST)
    assert.deepEqual([calls, store.log], [[], [['read', 'npm/versions', 'pkg@1.0.0']]])
  })

  it("passes on the store's own failures", async () => {
    stubRegistry()
    const failing = (what) => () => Promise.reject(new Error(`${what} failed`))
    await assert.rejects(getTarball('pkg', '1.0.0', DIST, { cache: { read: failing('read'), write: () => Promise.resolve() } }), /read failed/u)
    await assert.rejects(getTarball('pkg', '1.0.0', DIST, { cache: { read: () => Promise.resolve(), write: failing('write') } }), /write failed/u)
    await assert.rejects(getMeta('pkg', '1.0.0', { cache: { read: () => Promise.resolve(), write: failing('write') } }), /write failed/u)
    await assert.rejects(verifyDist('pkg', '1.0.0', DIST, { cache: { read: failing('read'), write: () => Promise.resolve() } }), /read failed/u)
  })

  it('with cache false, writes nothing, and reads the cache set as ever', async () => {
    let calls = stubRegistry()
    await getMeta('pkg', '1.0.0', { cache: false })
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', undefined, { cache: false })), BYTES)
    assert.deepEqual(calls, [DOC, DOC, TGZ])
    assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
    stubRegistry()
    await getTarball('pkg', '1.0.0')
    calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', undefined, { cache: false })), BYTES)
    assert.deepEqual(calls, [DOC])
    calls = offline()
    await verifyDist('pkg', '1.0.0', DIST, { cache: false })
    assert.deepEqual(calls, [])
  })

  it('refuses a cache that is neither false nor a store, and any other option, before any request', async () => {
    const calls = offline()
    for (const cache of [null, true, {}, { read() {} }, 'dir']) {
      const error = /cache must be false, or a store with read and write/u
      await assert.rejects(getMeta('pkg', '1.0.0', { cache }), error, String(cache))
      await assert.rejects(verifyDist('pkg', '1.0.0', DIST, { cache }), error, String(cache))
      await assert.rejects(getTarball('pkg', '1.0.0', DIST, { cache }), error, String(cache))
      await assert.rejects(getTarball('pkg', '1.0.0', undefined, { cache }), error, String(cache))
    }
    await assert.rejects(getMeta('pkg', '1.0.0', { store: false }), /getMeta: unknown option store/u)
    for (const [dist, error] of [
      [null, /getMeta: dist must be an options object/u],
      [DIST.integrity, /getMeta: dist must be an options object/u],
      [{ integrity: DIST.integrity }, /getMeta: dist\.tarball must be/u],
      [{ ...DIST, integrity: sri(BYTES, 'sha1') }, /getMeta: dist\.integrity must be "sha512-"/u],
      [{ ...DIST, tarball: 'https://evil.example/pkg/-/pkg-1.0.0.tgz' }, /getMeta: dist\.tarball must be https:\/\/registry\.npmjs\.org\/pkg\/-\/pkg-1\.0\.0\.tgz/u],
      [{ ...DIST, shasum: 'abc' }, /getMeta: unknown option dist\.shasum/u],
    ]) {
      await assert.rejects(getMeta('pkg', '1.0.0', { dist }), error, JSON.stringify(dist))
    }
    await assert.rejects(getTarball('pkg', '1.0.0', undefined, null), /getTarball: options must be an options object/u)
    assert.deepEqual(calls, [])
  })
})

describe('the caches of other tools', () => {
  const legacyPath = (root, name, version) => join(root, name, version, 'package.tgz')

  it('serves what cacache filed under the sha512, asking only for the version document', async () => {
    await plant(contentPath(NPM_CACHE, BYTES), BYTES)
    const calls = stubRegistry()
    const bytes = await getTarball('pkg', '1.0.0')
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), BYTES)
    assert.deepEqual(calls, [DOC])
    assert.deepEqual(await readdir(TARBALLS).catch(() => []), [])
  })

  it("serves npm 4's <name>/<version>/package.tgz, a scoped name nested", async () => {
    await plant(legacyPath(NPM_CACHE, 'pkg', '1.0.0'), BYTES)
    await plant(legacyPath(NPM_CACHE, '@scope/pkg', '2.0.0-rc.1'), BYTES)
    let calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC])
    calls = stubRegistry({ name: '@scope/pkg', version: '2.0.0-rc.1' })
    assert.deepEqual(new Uint8Array(await getTarball('@scope/pkg', '2.0.0-rc.1')), BYTES)
    assert.deepEqual(calls, ['https://registry.npmjs.org/@scope/pkg/2.0.0-rc.1'])
  })

  it('passes over bytes that do not match the registry, and downloads', async () => {
    const other = new Uint8Array([...BYTES, 0])
    await plant(contentPath(NPM_CACHE, BYTES), other)
    await plant(legacyPath(NPM_CACHE, 'pkg', '1.0.0'), other)
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC, tarballUrl('pkg', '1.0.0')])
    assert.deepEqual(new Uint8Array(await readFile(contentPath(NPM_CACHE, BYTES))), other)
    assert.deepEqual(await readdir(TARBALLS), ['pkg@1.0.0.tgz'])
  })

  it('passes over what is not a file', async () => {
    await mkdir(contentPath(NPM_CACHE, BYTES), { recursive: true })
    await mkdir(legacyPath(NPM_CACHE, 'pkg', '1.0.0'), { recursive: true })
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.equal(calls.length, 2)
  })

  it('comes before the cache of setCacheDir', async () => {
    await plant(contentPath(NPM_CACHE, BYTES), BYTES)
    await plant(join(TARBALLS, 'pkg@1.0.0.tgz'), new Uint8Array([...BYTES, 0]))
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC])
  })

  it("looks where npm does: npm_config_cache, ~/ expanded, else ~/.npm", { skip: process.platform === 'win32' }, async () => {
    try {
      for (const [set, root] of [
        [() => { process.env.npm_config_cache = '~/elsewhere' }, join(HOME, 'elsewhere')],
        [() => { delete process.env.npm_config_cache }, join(HOME, '.npm')],
        [() => { process.env.NPM_CONFIG_CACHE = join(LOCAL, 'upper') }, join(LOCAL, 'upper')],
      ]) {
        set()
        await rm(LOCAL, { recursive: true, force: true })
        await plant(contentPath(root, BYTES), BYTES)
        const calls = stubRegistry()
        assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES, root)
        assert.deepEqual(calls, [DOC], root)
      }
    } finally {
      process.env.npm_config_cache = NPM_CACHE
      delete process.env.NPM_CONFIG_CACHE
    }
  })

  it('serves ~/.audit/cache/tgz/<org>:<name>-<version>.tgz, and passes over a mismatch there', { skip: process.platform === 'win32' }, async () => {
    const audit = join(HOME, '.audit', 'cache', 'tgz')
    await plant(join(audit, 'pkg-1.0.0.tgz'), BYTES)
    await plant(join(audit, 'scope:pkg-2.0.0-rc.1.tgz'), BYTES)
    let calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC])
    calls = stubRegistry({ name: '@scope/pkg', version: '2.0.0-rc.1' })
    assert.deepEqual(new Uint8Array(await getTarball('@scope/pkg', '2.0.0-rc.1')), BYTES)
    assert.deepEqual(calls, ['https://registry.npmjs.org/@scope/pkg/2.0.0-rc.1'])
    await plant(join(audit, 'pkg-1.0.0.tgz'), new Uint8Array([...BYTES, 0]))
    calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC, tarballUrl('pkg', '1.0.0')])
  })
})

describe('getMeta, verifyDist, and getTarball with a dist', () => {

  it('answers the name, the version and a dist of only its tarball and integrity', async () => {
    const calls = stubRegistry({ dist: { shasum: 'abc', fileCount: 3, signatures: [] } })
    assert.deepEqual(await getMeta('pkg', '1.0.0'), { name: 'pkg', version: '1.0.0', dist: DIST })
    assert.deepEqual(calls, [DOC])
    stubRegistry({ name: '@scope/pkg' })
    assert.deepEqual(await getMeta('@scope/pkg', '1.0.0'), { name: '@scope/pkg', version: '1.0.0', dist: { tarball: tarballUrl('@scope/pkg', '1.0.0'), integrity: sri(BYTES) } })
  })

  it('answers the gitHead the document names, where it is a full commit id', async () => {
    const answer = (gitHead) => {
      globalThis.fetch = () => Promise.resolve(Response.json({ name: 'pkg', version: '1.0.0', dist: DIST, gitHead }))
    }
    for (const gitHead of ['a'.repeat(40), 'b'.repeat(64)]) {
      answer(gitHead)
      assert.deepEqual(await getMeta('pkg', '1.0.0'), { name: 'pkg', version: '1.0.0', dist: DIST, gitHead })
    }
    for (const gitHead of [undefined, null, '', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), ` ${'a'.repeat(40)}`, ['a'.repeat(40)], { sha: 'a'.repeat(40) }]) {
      answer(gitHead)
      assert.deepEqual(await getMeta('pkg', '1.0.0'), { name: 'pkg', version: '1.0.0', dist: DIST })
    }
  })

  it('answers the repository, homepage and bugs the document names, in the shapes a package.json gives them', async () => {
    const answer = (fields) => {
      globalThis.fetch = () => Promise.resolve(Response.json({ name: 'pkg', version: '1.0.0', dist: DIST, ...fields }))
    }
    const meta = async (fields) => {
      answer(fields)
      const { name, version, dist, ...rest } = await getMeta('pkg', '1.0.0')
      assert.deepEqual({ name, version, dist }, { name: 'pkg', version: '1.0.0', dist: DIST })
      return rest
    }
    const repository = { type: 'git', url: 'git+https://github.com/o/pkg.git', directory: 'packages/pkg' }
    const npm = { repository, homepage: 'https://github.com/o/pkg#readme', bugs: { url: 'https://github.com/o/pkg/issues', email: 'o@example.com' } }
    assert.deepEqual(await meta(npm), npm)
    assert.deepEqual(await meta({ repository: 'github:o/pkg', homepage: '', bugs: 'https://github.com/o/pkg/issues' }), { repository: 'github:o/pkg', homepage: '', bugs: 'https://github.com/o/pkg/issues' })
    assert.deepEqual(await meta({ repository: { url: 'https://github.com/o/pkg', web: 'x', type: 7 }, bugs: { email: 'o@example.com' } }), {
      repository: { type: undefined, url: 'https://github.com/o/pkg', directory: undefined },
      bugs: { url: undefined, email: 'o@example.com' },
    })
    for (const odd of [null, 7, true, [repository], { type: 7 }, {}]) {
      assert.deepEqual(await meta({ repository: odd, homepage: odd, bugs: odd }), {}, JSON.stringify(odd))
    }
  })

  it('refuses an answer about another version, or a dist not held to the rules', async () => {
    globalThis.fetch = () => Promise.resolve(Response.json({ name: 'pkg', version: '1.0.1', dist: DIST }))
    await assert.rejects(getMeta('pkg', '1.0.0'), /getMeta: the registry answered for .*1\.0\.1.*, not pkg@1\.0\.0/u)
    stubRegistry({ dist: { integrity: sri(BYTES, 'sha1') } })
    await assert.rejects(getMeta('pkg', '1.0.0'), /getMeta: dist\.integrity must be/u)
    stubRegistry({ dist: { tarball: 'https://evil.example/pkg-1.0.0.tgz' } })
    await assert.rejects(getMeta('pkg', '1.0.0'), /getMeta: dist\.tarball must be/u)
  })

  it("verifies a dist against the registry's, and throws on a different integrity", async () => {
    const calls = stubRegistry()
    await verifyDist('pkg', '1.0.0', DIST)
    assert.deepEqual(calls, [DOC])
    await rm(CACHE_DIR, { recursive: true, force: true })
    stubRegistry()
    await assert.rejects(verifyDist('pkg', '1.0.0', { ...DIST, integrity: OTHER }), (err) => err.message === `verifyDist: pkg@1.0.0 is ${sri(BYTES)} on the registry, not ${OTHER}`)
  })

  it('refuses a dist not held to the rules before any request', async () => {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }
    for (const [dist, error] of [
      [null, /dist must be an options object/u],
      [{ ...DIST, shasum: 'abc' }, /unknown option dist\.shasum/u],
      [{ ...DIST, integrity: `${DIST.integrity} ${DIST.integrity}` }, /dist\.integrity must be "sha512-"/u],
      [{ ...DIST, integrity: sri(BYTES, 'sha1') }, /dist\.integrity must be "sha512-"/u],
      [{ ...DIST, integrity: `sha512-${'A'.repeat(85)}B==` }, /dist\.integrity must be "sha512-"/u],
      [{ ...DIST, tarball: 'https://evil.example/pkg/-/pkg-1.0.0.tgz' }, /dist\.tarball must be https:\/\/registry\.npmjs\.org\/pkg\/-\/pkg-1\.0\.0\.tgz/u],
      [{ integrity: DIST.integrity }, /dist\.tarball must be/u],
    ]) {
      await assert.rejects(verifyDist('pkg', '1.0.0', dist), error, JSON.stringify(dist))
      await assert.rejects(getTarball('pkg', '1.0.0', dist), error, JSON.stringify(dist))
    }
    await assert.rejects(verifyDist('pkg', '1.0.0'), /verifyDist: dist must be an options object/u)
    await assert.rejects(verifyDist('_pkg', '1.0.0', DIST), /verifyDist: name must be an npm package name/u)
    assert.deepEqual(calls, [])
  })

  it('takes only the fields a given dist has of its own', async () => {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }
    // eslint-disable-next-line no-extend-native -- a polluted prototype is what this test is about
    for (const key of ['tarball', 'integrity']) Object.defineProperty(Object.prototype, key, { value: DIST[key], configurable: true })
    try {
      await assert.rejects(getTarball('pkg', '1.0.0', {}), /getTarball: dist\.integrity must be/u)
      await assert.rejects(verifyDist('pkg', '1.0.0', {}), /verifyDist: dist\.integrity must be/u)
      await assert.rejects(getTarball('pkg', '1.0.0', { integrity: DIST.integrity }), /getTarball: dist\.tarball must be/u)
    } finally {
      for (const key of ['tarball', 'integrity']) delete Object.prototype[key]
    }
    assert.deepEqual(calls, [])
  })

  it('holds a given dist to what it was when checked, read once', async () => {
    const mutable = { ...DIST }
    let calls = stubRegistry()
    const pending = getTarball('pkg', '1.0.0', mutable)
    Object.assign(mutable, { tarball: tarballUrl('other', '1.0.0'), integrity: OTHER })
    assert.deepEqual(new Uint8Array(await pending), BYTES)
    assert.deepEqual(calls, [tarballUrl('pkg', '1.0.0')])
    await rm(CACHE_DIR, { recursive: true, force: true })
    let reads = 0
    const shifting = { tarball: DIST.tarball, get integrity() { return reads++ === 0 ? DIST.integrity : OTHER } }
    calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', shifting)), BYTES)
    assert.equal(reads, 1)
    const given = { ...DIST }
    stubRegistry()
    const verifying = verifyDist('pkg', '1.0.0', given)
    given.integrity = OTHER
    await verifying
  })

  it('reads a tarball by a given dist, never asking for the version document', async () => {
    const calls = stubRegistry()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0', DIST)), BYTES)
    assert.deepEqual(calls, [tarballUrl('pkg', '1.0.0')])
    await rm(CACHE_DIR, { recursive: true, force: true })
    stubRegistry()
    await assert.rejects(getTarball('pkg', '1.0.0', { ...DIST, integrity: OTHER }), /getTarball: integrity mismatch for pkg@1\.0\.0 from https:/u)
  })
})

describe('getPublishTimes', () => {
  // The whole package's document, as the registry answers for it.
  const serve = (doc) => {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.resolve(Response.json(doc))
    }
    return calls
  }

  it('answers each version it lists by its time, as toISOString writes it', async () => {
    const time = { created: '2013-05-03T16:37:16.591Z', modified: '2022-06-13T06:42:08.512Z', '0.7.1': '2013-05-03T16:37:16.591Z', '0.8.0': '2014-01-02T03:04:05Z', '0.9.0': '2015-01-01T00:00:00.000Z' }
    const calls = serve({ name: 'colour', versions: { '0.7.1': {}, '0.8.0': {} }, time })
    assert.deepEqual(await getPublishTimes('colour'), new Map([['0.7.1', '2013-05-03T16:37:16.591Z'], ['0.8.0', '2014-01-02T03:04:05.000Z']]))
    assert.deepEqual(calls, ['https://registry.npmjs.org/colour'])
    serve({ name: '@scope/pkg', versions: { '1.0.0': {} }, time: { '1.0.0': '2020-02-02T02:02:02.002Z' } })
    assert.deepEqual(await getPublishTimes('@scope/pkg'), new Map([['1.0.0', '2020-02-02T02:02:02.002Z']]))
  })

  it('leaves out a version whose time is missing or not an ISO 8601 UTC time', async () => {
    // Date.parse would move each of the last four to another day.
    const times = { a: '2013-05-03', b: 'Fri May 03 2013', c: '2013-13-03T16:37:16.591Z', d: 1367599036591, e: '2013-05-03T16:37:16.591+04:00', g: '2018-02-29T00:00:00Z', h: '2018-02-30T00:00:00Z', i: '2018-04-31T12:00:00.5Z', j: '2018-02-28T24:00:00Z' }
    serve({ name: 'pkg', versions: Object.fromEntries([...Object.keys(times), 'f', 'k'].map((v) => [`1.0.0-${v}`, {}])), time: Object.fromEntries(Object.entries({ ...times, k: '2016-02-29T00:00:00.5Z' }).map(([v, t]) => [`1.0.0-${v}`, t])) })
    assert.deepEqual(await getPublishTimes('pkg'), new Map([['1.0.0-k', '2016-02-29T00:00:00.500Z']]))
    serve({ name: 'pkg', versions: { '1.0.0': {} } })
    assert.deepEqual(await getPublishTimes('pkg'), new Map())
  })

  it('refuses another package\'s document, and a name npm does not take before any request', async () => {
    serve({ name: 'other', versions: {}, time: {} })
    await assert.rejects(getPublishTimes('pkg'), /getPublishTimes: the registry answered for "other", not pkg/u)
    const calls = serve({})
    await assert.rejects(getPublishTimes('../pkg'), /getPublishTimes: name must be an npm package name/u)
    assert.deepEqual(calls, [])
  })
})
