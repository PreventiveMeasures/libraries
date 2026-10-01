import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { getCrate, resolveCrateRepos, verifyChecksum } from '../cargo.js'
import { setCacheDir } from '../npm.js'

const CACHE_DIR = join(tmpdir(), `upstream-cargo-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const CRATES = join(CACHE_DIR, 'cargo', 'crates')

// Cargo's home, where getCrate looks first: this file's own, so no crate
// on this machine answers for the stubs.
const CARGO_HOME = join(tmpdir(), `upstream-cargo-home-test-${process.pid}`)
process.env.CARGO_HOME = CARGO_HOME

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(CARGO_HOME, { recursive: true, force: true })
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(CARGO_HOME, { recursive: true, force: true })
})

// Not valid UTF-8, so bytes that went through a string anywhere would
// come back different.
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x42])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const INDEX = 'https://index.crates.io/cr/at/crate'
const CRATE = 'https://static.crates.io/crates/crate/crate-1.0.0.crate'

// crates.io, for one crate: its index file, a line per version in
// `versions` (each `{ vers, cksum?, name? }`), and every .crate as
// `served`. `calls` is every URL asked for.
function stubCratesIo({ name = 'crate', index = INDEX, versions = [{ vers: '1.0.0' }], served = BYTES } = {}) {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    if (String(url) === index) return Promise.resolve(new Response(versions.map((line) => JSON.stringify({ name, cksum: sha256(BYTES), yanked: false, ...line })).join('\n')))
    if (String(url).startsWith(`https://static.crates.io/crates/${name}/`)) return Promise.resolve(new Response(served))
    return Promise.resolve(new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }))
  }
  return calls
}

describe('getCrate', () => {
  it("reads the version's checksum off the index, then fetches the crate, bytes intact", async () => {
    const calls = stubCratesIo({ versions: [{ vers: '0.9.0', cksum: sha256(new Uint8Array([1])) }, { vers: '1.0.0' }] })
    const bytes = await getCrate('crate', '1.0.0')
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), BYTES)
    assert.deepEqual(calls, [INDEX, CRATE])
  })

  it('finds the index file by the lowercased name, as cargo does', async () => {
    for (const [name, index] of [['a', '1/a'], ['cc', '2/cc'], ['Syn', '3/s/syn'], ['Inflector', 'in/fl/inflector']]) {
      const calls = stubCratesIo({ name, index: `https://index.crates.io/${index}` })
      assert.deepEqual(new Uint8Array(await getCrate(name, '1.0.0')), BYTES)
      assert.deepEqual(calls, [`https://index.crates.io/${index}`, `https://static.crates.io/crates/${name}/${name}-1.0.0.crate`])
    }
  })

  it("encodes a version's build metadata in the crate's URL", async () => {
    const calls = stubCratesIo({ versions: [{ vers: '0.12.26+1.3.0' }] })
    await getCrate('crate', '0.12.26+1.3.0')
    assert.deepEqual(calls, [INDEX, 'https://static.crates.io/crates/crate/crate-0.12.26%2B1.3.0.crate'])
  })

  it('refuses bytes that do not match the checksum, and caches nothing', async () => {
    stubCratesIo({ served: new Uint8Array([...BYTES, 0]) })
    await assert.rejects(getCrate('crate', '1.0.0'), new RegExp(`getCrate: integrity mismatch for crate@1\\.0\\.0 from ${CRATE.replaceAll('.', '\\.')}: expected ${sha256(BYTES)}`, 'u'))
    assert.deepEqual(await readdir(CRATES).catch(() => []), [])
  })

  it('refuses an index that has not that version, or has it under another name', async () => {
    stubCratesIo({ versions: [{ vers: '1.0.1' }, { vers: '1.0.0-rc.1' }] })
    await assert.rejects(getCrate('crate', '1.0.0'), /getCrate: the index has no crate@1\.0\.0/u)
    stubCratesIo({ name: 'crate', index: 'https://index.crates.io/cr/at/crate' })
    await assert.rejects(getCrate('Crate', '1.0.0'), /getCrate: the index answered for "crate", not Crate/u)
  })

  it('takes a checksum off the index only as sha256 in lowercase hex', async () => {
    for (const cksum of [undefined, null, sha256(BYTES).toUpperCase(), sha256(BYTES).slice(1), `sha256-${sha256(BYTES)}`]) {
      const calls = stubCratesIo({ versions: [{ vers: '1.0.0', cksum }] })
      await assert.rejects(getCrate('crate', '1.0.0'), /getCrate: the index cksum must be a sha256 in lowercase hex/u, String(cksum))
      assert.deepEqual(calls, [INDEX])
    }
  })

  it('refuses an index line that is not JSON, and says so printably', async () => {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.resolve(new Response(`${JSON.stringify({ name: 'crate', vers: '0.9.0', cksum: sha256(BYTES) })}\n{"vers":\u001B[2J}`))
    }
    await assert.rejects(getCrate('crate', '1.0.0'), { message: 'getCrate: the index for crate has a line that is not JSON: {"vers":\\u001b[2J}' })
    assert.deepEqual(calls, [INDEX])
  })

  it('throws on a crate the index does not have', async () => {
    stubCratesIo()
    await assert.rejects(getCrate('other', '1.0.0'), { name: 'HttpError', status: 404 })
  })

  it('with a checksum, asks for the crate alone, and holds the bytes to it', async () => {
    let calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0', sha256(BYTES))), BYTES)
    assert.deepEqual(calls, [CRATE])
    await rm(CACHE_DIR, { recursive: true, force: true })
    calls = stubCratesIo()
    await assert.rejects(getCrate('crate', '1.0.0', sha256(new Uint8Array([1]))), /getCrate: integrity mismatch for crate@1\.0\.0 from https:/u)
    assert.deepEqual(calls, [CRATE])
  })

  it('refuses a malformed name, version or checksum before any request', async () => {
    for (const args of [
      ['', '1.0.0'], ['1crate', '1.0.0'], ['crate/../x', '1.0.0'], ['a'.repeat(65), '1.0.0'], [undefined, '1.0.0'],
      ['crate', '1.0'], ['crate', 'v1.0.0'], ['crate', '01.0.0'], ['crate', '1.0.0/x'], ['crate', undefined],
      ['crate', '1.0.0', null], ['crate', '1.0.0', ''], ['crate', '1.0.0', sha256(BYTES).toUpperCase()], ['crate', '1.0.0', { cksum: sha256(BYTES) }],
    ]) {
      const calls = stubCratesIo()
      await assert.rejects(getCrate(...args), /getCrate: (?:name|version|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })
})

describe('verifyChecksum', () => {
  it("passes a checksum that is the index's, asking for the index alone", async () => {
    const calls = stubCratesIo({ versions: [{ vers: '0.9.0', cksum: sha256(new Uint8Array([1])) }, { vers: '1.0.0' }] })
    await verifyChecksum('crate', '1.0.0', sha256(BYTES))
    assert.deepEqual(calls, [INDEX])
  })

  it("throws for a checksum that is not the index's, naming both", async () => {
    const other = sha256(new Uint8Array([1]))
    stubCratesIo()
    await assert.rejects(verifyChecksum('crate', '1.0.0', other), { message: `verifyChecksum: crate@1.0.0 is ${sha256(BYTES)} on crates.io, not ${other}` })
  })

  it('holds the index to what getCrate does, and caches nothing', async () => {
    stubCratesIo({ versions: [{ vers: '1.0.1' }] })
    await assert.rejects(verifyChecksum('crate', '1.0.0', sha256(BYTES)), /verifyChecksum: the index has no crate@1\.0\.0/u)
    stubCratesIo()
    await assert.rejects(verifyChecksum('Crate', '1.0.0', sha256(BYTES)), /verifyChecksum: the index answered for "crate", not Crate/u)
    stubCratesIo({ versions: [{ vers: '1.0.0', cksum: null }] })
    await assert.rejects(verifyChecksum('crate', '1.0.0', sha256(BYTES)), /verifyChecksum: the index cksum must be a sha256 in lowercase hex/u)
    stubCratesIo()
    await assert.rejects(verifyChecksum('other', '1.0.0', sha256(BYTES)), { name: 'HttpError', status: 404 })
    assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
  })

  it('refuses a malformed name, version or checksum before any request', async () => {
    for (const args of [['1crate', '1.0.0', sha256(BYTES)], ['crate', '1.0', sha256(BYTES)], ['crate', '1.0.0'], ['crate', '1.0.0', sha256(BYTES).toUpperCase()]]) {
      const calls = stubCratesIo()
      await assert.rejects(verifyChecksum(...args), /verifyChecksum: (?:name|version|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })
})

// crates.io's API for many crates at once, answering for those in
// `crates`, each its `repository`; `calls` is every name list asked for.
function stubCratesApi(crates) {
  const calls = []
  globalThis.fetch = (url, init) => {
    const asked = new URL(String(url))
    assert.equal(`${asked.origin}${asked.pathname}`, 'https://crates.io/api/v1/crates')
    assert.match(new Headers(init?.headers).get('user-agent'), /^@preventive\/upstream /u)
    const ids = asked.searchParams.getAll('ids[]')
    calls.push(ids)
    if (crates instanceof Response) return Promise.resolve(crates.clone())
    return Promise.resolve(Response.json({ crates: ids.filter((id) => Object.hasOwn(crates, id)).map((id) => ({ id, repository: crates[id] })) }))
  }
  return calls
}

describe('resolveCrateRepos', () => {
  it("maps each crate to the GitHub repo its repository names, leaving out those that name none or crates.io has not", async () => {
    const calls = stubCratesApi({ serde: 'https://github.com/serde-rs/serde', local: null, gitlab: 'https://gitlab.com/a/b' })
    const repos = await resolveCrateRepos(['serde', 'local', 'gitlab', 'missing', 'serde'])
    assert.deepEqual([...repos], [['serde', { github: 'serde-rs/serde' }]])
    assert.deepEqual(calls, [['serde', 'local', 'gitlab', 'missing']])
  })

  it('caches a repo found, and with cachedOnly answers from the cache alone', async () => {
    stubCratesApi({ serde: 'https://github.com/serde-rs/serde', local: null })
    await resolveCrateRepos(['serde', 'local'])
    const calls = stubCratesApi({})
    assert.deepEqual([...await resolveCrateRepos(['serde', 'local'], { cachedOnly: true })], [['serde', { github: 'serde-rs/serde' }]])
    assert.deepEqual(calls, [])
    assert.deepEqual([...await resolveCrateRepos(['local', 'serde'])], [['serde', { github: 'serde-rs/serde' }]])
    assert.deepEqual(calls, [['local']], 'only the crate with no repo is asked again')
  })

  it('is fail-soft: a request that fails leaves its crates out', async () => {
    stubCratesApi(Response.json({ errors: [{ detail: 'too many' }] }, { status: 500 }))
    assert.deepEqual([...await resolveCrateRepos(['serde'])], [])
    stubCratesApi(Response.json({ crates: [{ id: 'other', repository: 'https://github.com/a/b' }] }))
    assert.deepEqual([...await resolveCrateRepos(['serde'])], [])
  })

  it('refuses a malformed name, a string, or an unknown option, before any request', async () => {
    const calls = stubCratesApi({})
    await assert.rejects(resolveCrateRepos(['serde', '1crate']), /resolveCrateRepos: name must be a crate name/u)
    await assert.rejects(resolveCrateRepos('serde'), /crateNames must be an iterable of names/u)
    await assert.rejects(resolveCrateRepos(['serde'], { cached: true }), /resolveCrateRepos: unknown option cached/u)
    await assert.rejects(resolveCrateRepos(['serde'], { cachedOnly: 'yes' }), /cachedOnly must be a boolean/u)
    assert.deepEqual(calls, [])
  })
})

describe('the crate cache', () => {
  it('files the bytes, and serves them again with no request where the checksum is given', async () => {
    stubCratesIo({ versions: [{ vers: '1.0.0+meta' }] })
    await getCrate('crate', '1.0.0+meta')
    assert.deepEqual(await readdir(CRATES), ['crate@1.0.0%2Bmeta.crate'])
    assert.deepEqual(new Uint8Array(await readFile(join(CRATES, 'crate@1.0.0%2Bmeta.crate'))), BYTES)
    let calls = stubCratesIo({ versions: [{ vers: '1.0.0+meta' }] })
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0+meta')), BYTES)
    assert.deepEqual(calls, [INDEX])
    calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0+meta', sha256(BYTES))), BYTES)
    assert.deepEqual(calls, [])
  })

  it('throws on cached bytes that no longer match, rather than fetching over them', async () => {
    stubCratesIo()
    await getCrate('crate', '1.0.0')
    await writeFile(join(CRATES, 'crate@1.0.0.crate'), new Uint8Array([...BYTES, 0]))
    const calls = stubCratesIo()
    await assert.rejects(getCrate('crate', '1.0.0'), /getCrate: integrity mismatch for crate@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [INDEX])
  })
})

describe("cargo's own cache", () => {
  const plant = async (registry, file, bytes) => {
    const path = join(CARGO_HOME, 'registry', 'cache', registry, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  it("serves a registry's <name>-<version>.crate, still checked, and files nothing", async () => {
    await plant('index.crates.io-1949cf8c6b5b557f', 'crate-1.0.0.crate', BYTES)
    let calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0')), BYTES)
    assert.deepEqual(calls, [INDEX])
    calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0', sha256(BYTES))), BYTES)
    assert.deepEqual(calls, [])
    assert.deepEqual(await readdir(CRATES).catch(() => []), [])
  })

  it('passes over a file that does not match, whatever registry it is under, and downloads', async () => {
    await plant('index.crates.io-1949cf8c6b5b557f', 'crate-1.0.0.crate', new Uint8Array([...BYTES, 0]))
    await plant('my-registry-0123456789abcdef', 'crate-1.0.0.crate', new Uint8Array([0]))
    const calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0')), BYTES)
    assert.deepEqual(calls, [INDEX, CRATE])
  })

  it('reads nothing but a regular file', async () => {
    await mkdir(join(CARGO_HOME, 'registry', 'cache', 'index.crates.io-1949cf8c6b5b557f', 'crate-1.0.0.crate'), { recursive: true })
    const calls = stubCratesIo()
    assert.deepEqual(new Uint8Array(await getCrate('crate', '1.0.0')), BYTES)
    assert.deepEqual(calls, [INDEX, CRATE])
  })
})
