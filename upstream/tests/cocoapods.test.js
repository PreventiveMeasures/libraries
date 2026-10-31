import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { HttpError, getPodspec } from '../cocoapods.js'
import { setCacheDir } from '../npm.js'

const CACHE_DIR = join(tmpdir(), `upstream-cocoapods-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const PODSPECS = join(CACHE_DIR, 'cocoapods', 'podspecs')

// CocoaPods' home, where getPodspec looks first: this file's own, so no
// spec repo on this machine answers for the stubs.
const CP_HOME = join(tmpdir(), `upstream-cocoapods-home-test-${process.pid}`)
const REPOS = join(CP_HOME, 'repos')

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(CP_HOME, { recursive: true, force: true })
  globalThis.fetch = realFetch
  delete process.env.CP_REPOS_DIR
  process.env.CP_HOME_DIR = CP_HOME
})

afterEach(() => {
  delete process.env.CP_REPOS_DIR
  delete process.env.CP_HOME_DIR
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(CP_HOME, { recursive: true, force: true })
})

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

// Alamofire 5.8.1's podspec, as trunk serves it, and its checksum, as
// CocoaPods 1.17.0 wrote it in a Podfile.lock (lockfile's fixtures).
const PODSPEC = new TextEncoder().encode(`${JSON.stringify({
  name: 'Alamofire',
  version: '5.8.1',
  license: 'MIT',
  summary: 'Elegant HTTP Networking in Swift',
  homepage: 'https://github.com/Alamofire/Alamofire',
  authors: { 'Alamofire Software Foundation': 'info@alamofire.org' },
  source: { git: 'https://github.com/Alamofire/Alamofire.git', tag: '5.8.1' },
  documentation_url: 'https://alamofire.github.io/Alamofire/',
  platforms: { ios: '10.0', osx: '10.12', tvos: '10.0', watchos: '3.0' },
  swift_versions: ['5'],
  source_files: 'Source/*.swift',
  frameworks: 'CFNetwork',
  swift_version: '5',
}, null, 2)}\n`)
const SUM = '3ca42e259043ee0dc5c0cdd76c4bc568b8e42af7'
const URL_OF = 'https://cdn.cocoapods.org/Specs/d/a/2/Alamofire/5.8.1/Alamofire.podspec.json'
// Kept by version and checksum, a capital written `!` and the letter, as
// the cache names a file.
const FILE = '!alamofire@5.8.1-3ca42e259043ee0dc5c0cdd76c4bc568b8e42af7.podspec.json'

// Not valid UTF-8, so bytes that went through a string anywhere would
// come back different.
const BYTES = new Uint8Array([0x7b, 0xff, 0xfe, 0x80, 0x00, 0x7d])

// The CDN, serving `served` at `url` alone. `calls` is every URL asked
// for.
function stubCdn({ url = URL_OF, served = PODSPEC } = {}) {
  const calls = []
  globalThis.fetch = (asked) => {
    calls.push(String(asked))
    if (String(asked) === url) return Promise.resolve(new Response(served))
    return Promise.resolve(new Response('Couldn\'t find the requested file', { status: 404 }))
  }
  return calls
}

describe('getPodspec', () => {
  it("fetches a version's podspec from the CDN, by the md5 of its name, and holds it to Podfile.lock's checksum", async () => {
    assert.equal(sha1(PODSPEC), SUM)
    const calls = stubCdn()
    const bytes = await getPodspec('Alamofire', '5.8.1', SUM)
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), PODSPEC)
    assert.deepEqual(calls, [URL_OF])
  })

  it("follows the CDN's redirect to jsDelivr", async () => {
    const modes = []
    globalThis.fetch = (asked, init) => {
      modes.push(init?.redirect)
      return Promise.resolve(new Response(PODSPEC))
    }
    await getPodspec('Alamofire', '5.8.1', SUM)
    assert.deepEqual(modes, ['follow'])
  })

  it('keeps bytes intact', async () => {
    stubCdn({ served: BYTES })
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', sha1(BYTES))), BYTES)
  })

  it('encodes a name and a version in the URL, and shards by the name as written', async () => {
    for (const [name, version, url] of [
      ['NSObject+Rx', '5.2.2', 'https://cdn.cocoapods.org/Specs/5/a/1/NSObject%2BRx/5.2.2/NSObject%2BRx.podspec.json'],
      ['GoogleUtilities', '7.13.3', 'https://cdn.cocoapods.org/Specs/0/8/4/GoogleUtilities/7.13.3/GoogleUtilities.podspec.json'],
      ['React-Core', '0.74.0-rc.1', 'https://cdn.cocoapods.org/Specs/a/b/2/React-Core/0.74.0-rc.1/React-Core.podspec.json'],
      ['A~B\'C', '1.0+build.1', 'https://cdn.cocoapods.org/Specs/0/5/6/A~B%27C/1.0%2Bbuild.1/A~B%27C.podspec.json'],
    ]) {
      const calls = stubCdn({ url, served: BYTES })
      assert.deepEqual(new Uint8Array(await getPodspec(name, version, sha1(BYTES))), BYTES)
      assert.deepEqual(calls, [url])
    }
  })

  it('refuses bytes that do not match the checksum, and caches nothing', async () => {
    stubCdn({ served: new Uint8Array([...PODSPEC, 0x0a]) })
    await assert.rejects(getPodspec('Alamofire', '5.8.1', SUM), /getPodspec: integrity mismatch for Alamofire@5\.8\.1 from https:\/\/cdn\.cocoapods\.org\/Specs\/d\/a\/2\/Alamofire\/5\.8\.1\/Alamofire\.podspec\.json: expected 3ca42e/u)
    assert.deepEqual(await readdir(PODSPECS).catch(() => []), [])
  })

  it('throws on a version the CDN does not have', async () => {
    stubCdn()
    await assert.rejects(getPodspec('Alamofire', '9.9.9', SUM), (error) => error instanceof HttpError && error.status === 404)
  })

  it('refuses a malformed name, version or checksum before any request', async () => {
    for (const args of [
      ['Firebase/Core', '1.0.0', SUM], ['.hidden', '1.0.0', SUM], ['My Pod', '1.0.0', SUM], ['Pod(1)', '1.0.0', SUM], ['a\\b', '1.0.0', SUM], ['', '1.0.0', SUM], ['Pod\n', '1.0.0', SUM],
      ['Podé', '1.0.0', SUM], ['P'.repeat(1025), '1.0.0', SUM], [undefined, '1.0.0', SUM],
      ['Alamofire', '', SUM], ['Alamofire', 'v5.8.1', SUM], ['Alamofire', '5..8', SUM], ['Alamofire', '5.8.1/../x', SUM], ['Alamofire', '5.8.1 ', SUM], ['Alamofire', '~> 5.8', SUM], ['Alamofire', '5.8.1+', SUM], ['Alamofire', 5, SUM],
      ['Alamofire', '5.8.1'], ['Alamofire', '5.8.1', SUM.toUpperCase()], ['Alamofire', '5.8.1', SUM.slice(1)], ['Alamofire', '5.8.1', `${SUM}0`], ['Alamofire', '5.8.1', 'a'.repeat(64)],
    ]) {
      const calls = stubCdn()
      await assert.rejects(getPodspec(...args), /getPodspec: (?:name|version|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })

  it('takes a name of any character Podfile.lock does, each encoded', async () => {
    const name = "!\"#$%&'*+,-.0123456789:;<=>?@AZ[]^_`az{|}~"
    const encoded = '%21%22%23%24%25%26%27%2A%2B%2C-.0123456789%3A%3B%3C%3D%3E%3F%40AZ%5B%5D%5E_%60az%7B%7C%7D~'
    const url = `https://cdn.cocoapods.org/Specs/e/c/c/${encoded}/1.0/${encoded}.podspec.json`
    const calls = stubCdn({ url, served: BYTES })
    assert.deepEqual(new Uint8Array(await getPodspec(name, '1.0', sha1(BYTES))), BYTES)
    assert.deepEqual(calls, [url])
  })
})

describe('the podspec cache', () => {
  it('files the bytes by version and checksum, and serves them again with no request', async () => {
    stubCdn()
    await getPodspec('Alamofire', '5.8.1', SUM)
    assert.deepEqual(await readdir(PODSPECS), [FILE])
    assert.deepEqual(new Uint8Array(await readFile(join(PODSPECS, FILE))), PODSPEC)
    const calls = stubCdn()
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(calls, [])
  })

  it('keeps a podspec trunk has rewritten beside the one it replaced, each for its own checksum', async () => {
    stubCdn()
    await getPodspec('Alamofire', '5.8.1', SUM)
    const deprecated = new TextEncoder().encode(`${new TextDecoder().decode(PODSPEC).slice(0, -3)},\n  "deprecated": true\n}\n`)
    let calls = stubCdn({ served: deprecated })
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', sha1(deprecated))), deprecated)
    assert.deepEqual(calls, [URL_OF])
    assert.equal((await readdir(PODSPECS)).length, 2)
    calls = stubCdn({ served: deprecated })
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', sha1(deprecated))), deprecated)
    assert.deepEqual(calls, [])
  })

  it('throws on cached bytes that do not match, rather than fetching over them', async () => {
    stubCdn()
    await getPodspec('Alamofire', '5.8.1', SUM)
    await writeFile(join(PODSPECS, FILE), new Uint8Array([...PODSPEC, 0x0a]))
    const calls = stubCdn()
    await assert.rejects(getPodspec('Alamofire', '5.8.1', SUM), /getPodspec: integrity mismatch for Alamofire@5\.8\.1 from the cache/u)
    assert.deepEqual(calls, [])
  })
})

describe("CocoaPods' own spec repos", () => {
  const PATH = ['Specs', 'd', 'a', '2', 'Alamofire', '5.8.1', 'Alamofire.podspec.json']
  const plant = async (root, repo, bytes) => {
    const path = join(root, repo, ...PATH)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  it("serves a spec repo's podspec under $CP_HOME_DIR/repos, still checked, and files nothing", async () => {
    await plant(REPOS, 'trunk', PODSPEC)
    const calls = stubCdn()
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(calls, [])
    assert.deepEqual(await readdir(PODSPECS).catch(() => []), [])
  })

  it('reads $CP_REPOS_DIR in place of $CP_HOME_DIR/repos', async () => {
    const elsewhere = join(CP_HOME, 'elsewhere')
    process.env.CP_REPOS_DIR = elsewhere
    await plant(elsewhere, 'master', PODSPEC)
    let calls = stubCdn()
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(calls, [])
    await rm(elsewhere, { recursive: true })
    await plant(REPOS, 'trunk', new Uint8Array([0]))
    calls = stubCdn()
    await getPodspec('Alamofire', '5.8.1', SUM)
    assert.deepEqual(calls, [URL_OF])
  })

  it('passes over a file that does not match, whatever spec repo it is in, and downloads', async () => {
    await plant(REPOS, 'trunk', new Uint8Array([...PODSPEC, 0x0a]))
    await plant(REPOS, 'acme-specs', new Uint8Array([0]))
    const calls = stubCdn()
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(calls, [URL_OF])
  })

  it('reads nothing but a regular file', async () => {
    await mkdir(join(REPOS, 'trunk', ...PATH), { recursive: true })
    const calls = stubCdn()
    assert.deepEqual(new Uint8Array(await getPodspec('Alamofire', '5.8.1', SUM)), PODSPEC)
    assert.deepEqual(calls, [URL_OF])
  })
})
