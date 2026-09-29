import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { setCacheDir } from '../npm.js'
import { getZip } from '../soldeer.js'

const CACHE_DIR = join(tmpdir(), `upstream-soldeer-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const ZIPS = join(CACHE_DIR, 'soldeer', 'zips')

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
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0x00, 0x42])
const SUM = createHash('sha256').update(BYTES).digest('hex')
const LOOKUP = 'https://api.soldeer.xyz/api/v1/revision-cli?project_name=forge-std&revision=1.9.2'
const ZIP = 'https://soldeer-revisions.s3.amazonaws.com/forge-std/1_9_2_06-08-2024_17:31:25_forge-std-1.9.2.zip'

// The registry, for one version of one package: its revision, as `revision`
// overrides it, and its zip as `served`. `calls` is every URL asked for.
function stubSoldeer({ name = 'forge-std', version = '1.9.2', revision = {}, served = BYTES } = {}) {
  const calls = []
  const url = revision.url ?? ZIP.replace('forge-std/', `${name}/`)
  const lookup = `https://api.soldeer.xyz/api/v1/revision-cli?${new URLSearchParams({ project_name: name, revision: version })}`
  globalThis.fetch = (asked) => {
    calls.push(String(asked))
    if (String(asked) === lookup) return Promise.resolve(Response.json({ data: [{ version, url, deleted: false, private: false, ...revision }], status: 'success' }))
    if (String(asked) === url) return Promise.resolve(new Response(served))
    return Promise.resolve(Response.json({ message: 'No revisions found', status: 'fail' }, { status: 404 }))
  }
  return calls
}

describe('getZip', () => {
  it('asks the registry where the zip is, then fetches it, bytes intact', async () => {
    const calls = stubSoldeer()
    const bytes = await getZip('forge-std', '1.9.2', SUM)
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), BYTES)
    assert.deepEqual(calls, [LOOKUP, ZIP])
  })

  it("takes a name starting with `@`, and a version that isn't semver", async () => {
    for (const [name, version] of [['@openzeppelin-contracts', '5.7.0-rc.0'], ['solmate', '89365b880c4f3c786bdd453d4b8e8fe410344a69'], ['solmate', '6'], ['@uniswap-v3-core', '1.0.2-solc-0.8-simulate']]) {
      const calls = stubSoldeer({ name, version })
      assert.deepEqual(new Uint8Array(await getZip(name, version, SUM)), BYTES)
      assert.equal(calls[0], `https://api.soldeer.xyz/api/v1/revision-cli?project_name=${encodeURIComponent(name)}&revision=${version}`)
    }
  })

  it('refuses bytes that do not match the checksum, and caches nothing', async () => {
    stubSoldeer({ served: new Uint8Array([...BYTES, 0]) })
    await assert.rejects(getZip('forge-std', '1.9.2', SUM), /getZip: integrity mismatch for forge-std@1\.9\.2 from https:\/\/soldeer-revisions\.s3\.amazonaws\.com\/forge-std\/1_9_2_/u)
    assert.deepEqual(await readdir(ZIPS).catch(() => []), [])
  })

  it('refuses an answer for another version', async () => {
    for (const revision of [{ version: '1.9.3' }, { version: undefined }]) {
      const calls = stubSoldeer({ revision })
      await assert.rejects(getZip('forge-std', '1.9.2', SUM), /getZip: the registry answered for .*, not forge-std@1\.9\.2/u)
      assert.deepEqual(calls, [LOOKUP])
    }
  })

  it("takes the zip only from under the package's own name in the bucket", async () => {
    for (const url of [
      'https://soldeer-revisions.s3.amazonaws.com/other/1_9_2_forge-std-1.9.2.zip',
      'https://soldeer-revisions.s3.amazonaws.com/forge-std-evil/1_9_2.zip',
      'https://soldeer-revisions.s3.amazonaws.com/forge-std.zip',
      'https://evil.example/forge-std/1_9_2.zip',
      'http://soldeer-revisions.s3.amazonaws.com/forge-std/1_9_2.zip',
      'https://soldeer-revisions.s3.amazonaws.com.evil.example/forge-std/1_9_2.zip',
      undefined,
    ]) {
      const calls = stubSoldeer({ revision: { url } })
      await assert.rejects(getZip('forge-std', '1.9.2', SUM), /getZip: the registry keeps forge-std@1\.9\.2 outside https:\/\/soldeer-revisions\.s3\.amazonaws\.com\/forge-std\//u, String(url))
      assert.deepEqual(calls, [LOOKUP])
    }
  })

  it('throws on a version the registry does not have', async () => {
    stubSoldeer()
    await assert.rejects(getZip('forge-std', '9.9.9', SUM), { name: 'HttpError', status: 404 })
  })

  it('refuses a malformed name, version or checksum before any request', async () => {
    for (const args of [
      ['Forge-std', '1.9.2', SUM], ['fs', '1.9.2', SUM], ['forge-std-', '1.9.2', SUM], ['-forge-std', '1.9.2', SUM], ['forge_std', '1.9.2', SUM], ['|forge', '1.9.2', SUM], ['@scope/pkg', '1.9.2', SUM], [undefined, '1.9.2', SUM],
      ['forge-std', '', SUM], ['forge-std', '.1', SUM], ['forge-std', '1.9.2/../x', SUM], ['forge-std', '1.9.2 ', SUM], ['forge-std', '^1.9.0', SUM], ['forge-std', 'a'.repeat(129), SUM], ['forge-std', 1, SUM],
      ['forge-std', '1.9.2'], ['forge-std', '1.9.2', SUM.toUpperCase()], ['forge-std', '1.9.2', SUM.slice(1)], ['forge-std', '1.9.2', `sha256-${SUM}`],
    ]) {
      const calls = stubSoldeer()
      await assert.rejects(getZip(...args), /getZip: (?:name|version|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })
})

describe('the zip cache', () => {
  it('files the bytes, a scoped name included, and serves them again with no request', async () => {
    stubSoldeer({ name: '@openzeppelin-contracts', version: '5.7.0' })
    await getZip('@openzeppelin-contracts', '5.7.0', SUM)
    assert.deepEqual(await readdir(ZIPS), ['@openzeppelin-contracts@5.7.0.zip'])
    assert.deepEqual(new Uint8Array(await readFile(join(ZIPS, '@openzeppelin-contracts@5.7.0.zip'))), BYTES)
    const calls = stubSoldeer({ name: '@openzeppelin-contracts', version: '5.7.0' })
    assert.deepEqual(new Uint8Array(await getZip('@openzeppelin-contracts', '5.7.0', SUM)), BYTES)
    assert.deepEqual(calls, [])
  })

  it('throws on cached bytes that do not match, rather than fetching over them', async () => {
    stubSoldeer()
    await getZip('forge-std', '1.9.2', SUM)
    await writeFile(join(ZIPS, 'forge-std@1.9.2.zip'), new Uint8Array([...BYTES, 0]))
    const calls = stubSoldeer()
    await assert.rejects(getZip('forge-std', '1.9.2', SUM), /getZip: integrity mismatch for forge-std@1\.9\.2 from the cache/u)
    assert.deepEqual(calls, [])
  })
})
