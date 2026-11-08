import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { setCacheDir } from '../npm.js'
import { HttpError, getGem, verifyChecksum } from '../rubygems.js'

const CACHE_DIR = join(tmpdir(), `upstream-rubygems-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const GEMS = join(CACHE_DIR, 'rubygems', 'gems')

// RubyGems' directories, where getGem looks first: GEM_HOME, GEM_PATH and
// the home Gem.user_dir is under, all this file's own, so no gem on this
// machine answers for the stubs.
const RUBY = join(tmpdir(), `upstream-rubygems-home-test-${process.pid}`)
const HOME = join(RUBY, 'home')
const GEM_HOME = join(RUBY, 'gem-home')
const GEM_PATH = [join(RUBY, 'path-a'), join(RUBY, 'path-b')]
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.GEM_HOME = GEM_HOME
process.env.GEM_PATH = GEM_PATH.join(delimiter)

const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(RUBY, { recursive: true, force: true })
  delete process.env.XDG_DATA_HOME
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(RUBY, { recursive: true, force: true })
})

// Not valid UTF-8, so bytes that went through a string anywhere would
// come back different.
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x42])
const OTHER = new Uint8Array([1])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const INDEX = 'https://index.rubygems.org/info/gem'
const GEM = 'https://rubygems.org/gems/gem-1.0.0.gem'

// A compact index line as rubygems.org writes one: `{ version, platform?,
// deps?, checksum? }`, the checksum BYTES' unless given, or `metadata` in
// place of all after `|`; a string as it is.
const lineOf = (entry) => {
  if (typeof entry === 'string') return entry
  const { version, platform, deps = '', checksum = sha256(BYTES), metadata = `checksum:${checksum},ruby:>= 2.4.0,created_at:2024-10-14T01:53:03Z` } = entry
  return `${version}${platform ? `-${platform}` : ''} ${deps}|${metadata}`
}

// rubygems.org, for one gem: its compact index, `---` and a line per
// version in `versions`, and every .gem as `served`; anything else a 403,
// as its bucket answers for a file it has not. `calls` is every URL asked
// for, and `redirects` the redirect mode of each.
let redirects = []
function stubRubygems({ name = 'gem', versions = [{ version: '1.0.0' }], index, served = BYTES } = {}) {
  const calls = []
  redirects = []
  globalThis.fetch = (url, init) => {
    calls.push(String(url))
    redirects.push(init?.redirect)
    if (String(url) === `https://index.rubygems.org/info/${name}`) return Promise.resolve(new Response(index ?? `---\n${versions.map(lineOf).join('\n')}\n`))
    if (String(url).startsWith(`https://rubygems.org/gems/${name}-`)) return Promise.resolve(served instanceof Response ? served : new Response(served))
    if (String(url).startsWith('https://index.rubygems.org/info/')) return Promise.resolve(new Response('This gem could not be found', { status: 404 }))
    return Promise.resolve(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
  }
  return calls
}

describe('getGem', () => {
  it("reads the version's checksum off the index, then fetches the gem, bytes intact", async () => {
    const calls = stubRubygems({ versions: [{ version: '0.9.0', checksum: sha256(OTHER) }, { version: '1.0.0', deps: 'rack:< 4&>= 2.2,racc:~> 1.4' }, { version: '1.0.0', platform: 'java', checksum: sha256(OTHER) }] })
    const bytes = await getGem('gem', '1.0.0', 'ruby')
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(new Uint8Array(bytes), BYTES)
    assert.deepEqual(calls, [INDEX, GEM])
    assert.deepEqual(redirects, ['manual', 'manual'])
  })

  it('picks the line of exactly that version and platform', async () => {
    const versions = [
      { version: '1.0.0', checksum: sha256(OTHER) },
      { version: '1.0.0.rc1', platform: 'x86_64-linux', checksum: sha256(OTHER) },
      { version: '1.0.0', platform: 'x86_64-linux-musl', checksum: sha256(OTHER) },
      { version: '1.0.0', platform: 'x86_64-linux' },
      { version: '1.0.0', platform: 'x86-linux', checksum: sha256(OTHER) },
    ]
    const calls = stubRubygems({ versions })
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'x86_64-linux')), BYTES)
    assert.deepEqual(calls, [INDEX, 'https://rubygems.org/gems/gem-1.0.0-x86_64-linux.gem'])
    stubRubygems({ versions })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), new RegExp(`getGem: integrity mismatch for gem@1\\.0\\.0 from ${GEM.replaceAll('.', '\\.')}: expected ${sha256(OTHER)}`, 'u'))
  })

  it("names a platform gem's file as RubyGems does, and a ruby one with no platform", async () => {
    for (const platform of ['java', 'x64-mingw-ucrt', 'arm64-darwin', 'arm64-darwin-23', 'x86-mswin32-60', 'x86_64-solaris-2.11', 'universal.x86_64-darwin-13']) {
      const calls = stubRubygems({ versions: [{ version: '1.0.0.pre.1', platform }] })
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0.pre.1', platform)), BYTES, platform)
      assert.deepEqual(calls, [INDEX, `https://rubygems.org/gems/gem-1.0.0.pre.1-${platform}.gem`])
    }
    const calls = stubRubygems({ name: 'my_gem.rb-x', versions: [{ version: '2' }] })
    await getGem('my_gem.rb-x', '2', 'ruby')
    assert.deepEqual(calls, ['https://index.rubygems.org/info/my_gem.rb-x', 'https://rubygems.org/gems/my_gem.rb-x-2.gem'])
  })

  it('reads the lines after the first `---`, as Bundler does, or every line where there is none', async () => {
    let calls = stubRubygems({ index: `not a line\n---\n${lineOf({ version: '1.0.0' })}` })
    await getGem('gem', '1.0.0', 'ruby')
    assert.deepEqual(calls, [INDEX, GEM])
    await rm(CACHE_DIR, { recursive: true, force: true })
    calls = stubRubygems({ index: `${lineOf({ version: '1.0.0' })}\n\n` })
    await getGem('gem', '1.0.0', 'ruby')
    assert.deepEqual(calls, [INDEX, GEM])
  })

  it('refuses an index that has not that version and platform, or has it twice', async () => {
    stubRubygems({ versions: [{ version: '1.0.1' }, { version: '1.0.0.rc1' }, { version: '1.0.0', platform: 'java' }] })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), { message: 'getGem: the index has no gem@1.0.0' })
    stubRubygems()
    await assert.rejects(getGem('gem', '1.0.0', 'x86_64-linux'), { message: 'getGem: the index has no gem@1.0.0-x86_64-linux' })
    const calls = stubRubygems({ versions: [{ version: '1.0.0' }, { version: '1.0.0', platform: 'ruby' }] })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), { message: 'getGem: the index has gem@1.0.0 on 2 lines' })
    assert.deepEqual(calls, [INDEX])
  })

  it('counts a line of a platform RubyGems reads as the one asked, as Bundler would take the later', async () => {
    stubRubygems({ versions: [{ version: '1.0.0', platform: 'x86-linux' }, { version: '1.0.0', platform: 'i686-linux', checksum: sha256(OTHER) }] })
    await assert.rejects(getGem('gem', '1.0.0', 'x86-linux'), { message: 'getGem: the index has gem@1.0.0-x86-linux on 2 lines' })
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'x86-linux', sha256(BYTES)), { message: 'verifyChecksum: the index has gem@1.0.0-x86-linux on 2 lines' })
    stubRubygems({ versions: [{ version: '1.0.0', platform: 'universal-darwin16', checksum: sha256(OTHER) }, { version: '1.0.0', platform: 'universal-darwin-16' }] })
    await assert.rejects(getGem('gem', '1.0.0', 'universal-darwin-16'), { message: 'getGem: the index has gem@1.0.0-universal-darwin-16 on 2 lines' })
  })

  it('refuses an index too long to be one, before reading a line of it', async () => {
    const calls = stubRubygems({ index: `---\n${lineOf({ version: '1.0.0' })}\n${'x'.repeat(16 * 1024 * 1024)}` })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), { message: `getGem: the index for gem is over ${16 * 1024 * 1024} characters` })
    assert.deepEqual(calls, [INDEX])
  })

  it("refuses a line that is not a version's, whichever version it is of, and says so printably", async () => {
    for (const line of ['1.0.1', '1.0.1 rack:>= 1', '', ' 1.0.1 |checksum:x', '-java |checksum:x', '1.0.1- |checksum:x', `${lineOf({ version: '1.0.1' })}\r`, '1.0.1\t|checksum:x', '1.0.1_x |checksum:x', '1.0.1\u0000 |checksum:x', '1.0.1-current |checksum:x']) {
      const calls = stubRubygems({ versions: [{ version: '1.0.0' }, line, { version: '1.0.2' }] })
      await assert.rejects(getGem('gem', '1.0.0', 'ruby'), /^AssertionError \[ERR_ASSERTION\]: getGem: the index for gem has a line that is not a version's: /u, JSON.stringify(line))
      assert.deepEqual(calls, [INDEX])
    }
    stubRubygems({ versions: ['1.0.0 \u001B[2J'] })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), { message: "getGem: the index for gem has a line that is not a version's: 1.0.0 \\u001b[2J" })
  })

  it("takes the line's one checksum, and only as sha256 in lowercase hex", async () => {
    const hex = sha256(BYTES)
    for (const [metadata, message] of [
      ['ruby:>= 2.4.0', /getGem: the index has 0 checksums for gem@1\.0\.0$/u],
      [`checksum:${hex},checksum:${hex}`, /getGem: the index has 2 checksums for gem@1\.0\.0$/u],
      [`checksum:${hex.toUpperCase()}`, /getGem: the index checksum must be a sha256 in lowercase hex/u],
      [`checksum:${hex.slice(1)}`, /getGem: the index checksum must be a sha256 in lowercase hex/u],
      [`checksum:${Buffer.from(hex, 'hex').toString('base64')}`, /getGem: the index checksum must be a sha256 in lowercase hex/u],
      [`checksum:sha256=${hex}`, /getGem: the index checksum must be a sha256 in lowercase hex/u],
      [`checksum: ${hex}`, /getGem: the index checksum must be a sha256 in lowercase hex/u],
    ]) {
      const calls = stubRubygems({ versions: [{ version: '1.0.0', metadata }] })
      await assert.rejects(getGem('gem', '1.0.0', 'ruby'), message, metadata)
      assert.deepEqual(calls, [INDEX])
    }
    const calls = stubRubygems({ versions: [{ version: '1.0.0', metadata: `rubygems:> 1.3.1,checksum:${hex},created_at:2024-10-14T01:53:03Z` }] })
    await getGem('gem', '1.0.0', 'ruby')
    assert.deepEqual(calls, [INDEX, GEM])
  })

  it('throws on a gem the index does not have, and on a file rubygems.org has not', async () => {
    stubRubygems()
    await assert.rejects(getGem('other', '1.0.0', 'ruby'), { name: 'HttpError', status: 404 })
    stubRubygems({ served: new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }) })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby', sha256(BYTES)), (err) => err instanceof HttpError && err.status === 403)
  })

  it('follows no redirect, wherever it points', async () => {
    const calls = stubRubygems({ served: new Response(null, { status: 302, headers: { location: 'https://example.com/gem-1.0.0.gem' } }) })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), { name: 'HttpError', status: 302 })
    assert.deepEqual(calls, [INDEX, GEM])
    assert.deepEqual(redirects, ['manual', 'manual'])
    assert.deepEqual(await readdir(GEMS).catch(() => []), [])
  })

  it('refuses bytes that do not match the checksum, and caches nothing', async () => {
    stubRubygems({ served: new Uint8Array([...BYTES, 0]) })
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), new RegExp(`getGem: integrity mismatch for gem@1\\.0\\.0 from ${GEM.replaceAll('.', '\\.')}: expected ${sha256(BYTES)}`, 'u'))
    assert.deepEqual(await readdir(GEMS).catch(() => []), [])
  })

  it("with a checksum, bare or as Gemfile.lock's, asks for the gem alone, and holds the bytes to it", async () => {
    for (const checksum of [sha256(BYTES), `sha256=${sha256(BYTES)}`]) {
      await rm(CACHE_DIR, { recursive: true, force: true })
      const calls = stubRubygems()
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby', checksum)), BYTES)
      assert.deepEqual(calls, [GEM])
    }
    for (const checksum of [sha256(OTHER), `sha256=${sha256(OTHER)}`]) {
      await rm(CACHE_DIR, { recursive: true, force: true })
      const calls = stubRubygems()
      await assert.rejects(getGem('gem', '1.0.0', 'ruby', checksum), new RegExp(`getGem: integrity mismatch for gem@1\\.0\\.0 from https:.*: expected ${sha256(OTHER)}, got ${sha256(BYTES)}$`, 'u'))
      assert.deepEqual(calls, [GEM])
    }
  })

  it('refuses a malformed name, version, platform or checksum before any request', async () => {
    const hex = sha256(BYTES)
    for (const args of [
      ['', '1.0.0', 'ruby'], ['-gem', '1.0.0', 'ruby'], ['_gem', '1.0.0', 'ruby'], ['.gem', '1.0.0', 'ruby'], ['123', '1.0.0', 'ruby'],
      ['gem/../x', '1.0.0', 'ruby'], ['gem name', '1.0.0', 'ruby'], ['a'.repeat(257), '1.0.0', 'ruby'], [undefined, '1.0.0', 'ruby'],
      ['gem', '', 'ruby'], ['gem', 'v1.0', 'ruby'], ['gem', '1.0-beta', 'ruby'], ['gem', '1.0.0/x', 'ruby'], ['gem', '1..0', 'ruby'], ['gem', '1.0.', 'ruby'], ['gem', 1, 'ruby'], ['gem', undefined, 'ruby'],
      ['gem', '1.0.0'], ['gem', '1.0.0', ''], ['gem', '1.0.0', null], ['gem', '1.0.0', 'current'], ['gem', '1.0.0', '..'], ['gem', '1.0.0', '../x'],
      ['gem', '1.0.0', '..-linux'], ['gem', '1.0.0', 'x86_64-linux/../x'], ['gem', '1.0.0', 'x86_64-linux/x'], ['gem', '1.0.0', 'x86_64-linux\\x'], ['gem', '1.0.0', 'x86_64-linux '],
      ['gem', '1.0.0', 'i686-linux'], ['gem', '1.0.0', 'mswin32'], ['gem', '1.0.0', 'jruby'], ['gem', '1.0.0', 'x86_64-darwin23'], ['gem', '1.0.0', 'X86_64-Linux'],
      ['gem', '1.0.0', 'universal..x86_64-darwin-13'], ['gem', '1.0.0', '2-linux'], ['gem', '1.0.0', `${'x'.repeat(128)}-linux`],
      ['gem', '1.0.0', 'ruby', null], ['gem', '1.0.0', 'ruby', ''], ['gem', '1.0.0', 'ruby', hex.toUpperCase()], ['gem', '1.0.0', 'ruby', `sha256-${hex}`],
      ['gem', '1.0.0', 'ruby', `sha512=${hex}`], ['gem', '1.0.0', 'ruby', `SHA256=${hex}`], ['gem', '1.0.0', 'ruby', `sha256=${hex}x`], ['gem', '1.0.0', 'ruby', `sha256=sha256=${hex}`], ['gem', '1.0.0', 'ruby', { checksum: hex }],
    ]) {
      const calls = stubRubygems()
      await assert.rejects(getGem(...args), /getGem: (?:name|version|platform|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })
})

describe('verifyChecksum', () => {
  it("passes a checksum that is the index's, bare or as Gemfile.lock's, asking for the index alone", async () => {
    for (const checksum of [sha256(BYTES), `sha256=${sha256(BYTES)}`]) {
      const calls = stubRubygems({ versions: [{ version: '0.9.0', checksum: sha256(OTHER) }, { version: '1.0.0', platform: 'x86_64-linux' }, { version: '1.0.0', checksum: sha256(OTHER) }] })
      await verifyChecksum('gem', '1.0.0', 'x86_64-linux', checksum)
      assert.deepEqual(calls, [INDEX])
    }
  })

  it("throws for a checksum that is not the index's, naming both", async () => {
    stubRubygems()
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'ruby', `sha256=${sha256(OTHER)}`), { message: `verifyChecksum: gem@1.0.0 is ${sha256(BYTES)} on rubygems.org, not ${sha256(OTHER)}` })
  })

  it('holds the index to what getGem does, and caches nothing', async () => {
    stubRubygems({ versions: [{ version: '1.0.1' }] })
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'ruby', sha256(BYTES)), /verifyChecksum: the index has no gem@1\.0\.0/u)
    stubRubygems({ versions: [{ version: '1.0.0', platform: 'java' }, { version: '1.0.0', platform: 'java' }] })
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'java', sha256(BYTES)), /verifyChecksum: the index has gem@1\.0\.0-java on 2 lines/u)
    stubRubygems({ versions: ['1.0.1'] })
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'ruby', sha256(BYTES)), /verifyChecksum: the index for gem has a line that is not a version's/u)
    stubRubygems({ versions: [{ version: '1.0.0', checksum: 'x' }] })
    await assert.rejects(verifyChecksum('gem', '1.0.0', 'ruby', sha256(BYTES)), /verifyChecksum: the index checksum must be a sha256 in lowercase hex/u)
    stubRubygems()
    await assert.rejects(verifyChecksum('other', '1.0.0', 'ruby', sha256(BYTES)), { name: 'HttpError', status: 404 })
    assert.deepEqual(await readdir(CACHE_DIR).catch(() => []), [])
  })

  it('refuses a malformed name, version, platform or checksum before any request', async () => {
    for (const args of [['1', '1.0.0', 'ruby', sha256(BYTES)], ['gem', '1.0-rc', 'ruby', sha256(BYTES)], ['gem', '1.0.0', '..-linux', sha256(BYTES)], ['gem', '1.0.0', sha256(BYTES)], ['gem', '1.0.0', 'ruby'], ['gem', '1.0.0', 'ruby', `sha256=${sha256(BYTES).toUpperCase()}`]]) {
      const calls = stubRubygems()
      await assert.rejects(verifyChecksum(...args), /verifyChecksum: (?:name|version|platform|checksum) must be/u, JSON.stringify(args))
      assert.deepEqual(calls, [])
    }
  })
})

describe('the gem cache', () => {
  it('files the bytes by name, version and platform, and serves them again with no request where the checksum is given', async () => {
    stubRubygems({ versions: [{ version: '1.0.0' }, { version: '1.0.0', platform: 'x86_64-linux' }] })
    await getGem('gem', '1.0.0', 'ruby')
    await getGem('gem', '1.0.0', 'x86_64-linux')
    assert.deepEqual((await readdir(GEMS)).toSorted(), ['gem@1.0.0-x86_64-linux.gem', 'gem@1.0.0.gem'])
    assert.deepEqual(new Uint8Array(await readFile(join(GEMS, 'gem@1.0.0-x86_64-linux.gem'))), BYTES)
    let calls = stubRubygems({ versions: [{ version: '1.0.0', platform: 'x86_64-linux' }] })
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'x86_64-linux')), BYTES)
    assert.deepEqual(calls, [INDEX])
    calls = stubRubygems()
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby', `sha256=${sha256(BYTES)}`)), BYTES)
    assert.deepEqual(calls, [])
  })

  it('throws on cached bytes that no longer match, rather than fetching over them', async () => {
    stubRubygems()
    await getGem('gem', '1.0.0', 'ruby')
    await writeFile(join(GEMS, 'gem@1.0.0.gem'), new Uint8Array([...BYTES, 0]))
    let calls = stubRubygems()
    await assert.rejects(getGem('gem', '1.0.0', 'ruby'), /getGem: integrity mismatch for gem@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [INDEX])
    calls = stubRubygems()
    await assert.rejects(getGem('gem', '1.0.0', 'ruby', sha256(BYTES)), /getGem: integrity mismatch for gem@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [])
  })
})

describe("RubyGems' own caches", () => {
  const plant = async (dir, file, bytes) => {
    const path = join(dir, 'cache', file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  const DIRS = {
    'GEM_HOME': GEM_HOME,
    'the first of GEM_PATH': GEM_PATH[0],
    'the last of GEM_PATH': GEM_PATH[1],
    '~/.gem': join(HOME, '.gem', 'ruby', '3.3.0'),
    '~/.gem, of another engine': join(HOME, '.gem', 'jruby', '3.1.0'),
    '~/.local/share/gem': join(HOME, '.local', 'share', 'gem', 'ruby', '3.4.0'),
  }

  for (const [where, dir] of Object.entries(DIRS)) {
    it(`serves <full name>.gem from the cache/ of ${where}, still checked, and files nothing`, async () => {
      await plant(dir, 'gem-1.0.0.gem', BYTES)
      await plant(dir, 'gem-1.0.0-x86_64-linux.gem', BYTES)
      let calls = stubRubygems()
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby')), BYTES)
      assert.deepEqual(calls, [INDEX])
      calls = stubRubygems()
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby', sha256(BYTES))), BYTES)
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'x86_64-linux', sha256(BYTES))), BYTES)
      assert.deepEqual(calls, [])
      assert.deepEqual(await readdir(GEMS).catch(() => []), [])
    })
  }

  it('reads $XDG_DATA_HOME/gem for ~/.local/share/gem where it is absolute', async () => {
    process.env.XDG_DATA_HOME = join(RUBY, 'data')
    await plant(join(RUBY, 'data', 'gem', 'ruby', '3.3.0'), 'gem-1.0.0.gem', BYTES)
    const calls = stubRubygems()
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby', sha256(BYTES))), BYTES)
    assert.deepEqual(calls, [])
  })

  it('passes over a file that does not match, wherever it is, and downloads', async () => {
    for (const dir of Object.values(DIRS)) await plant(dir, 'gem-1.0.0.gem', new Uint8Array([...BYTES, 0]))
    await plant(DIRS['~/.gem'], 'gem-1.0.0-ruby.gem', BYTES)
    await plant(DIRS['~/.gem'], 'gem@1.0.0.gem', BYTES)
    const calls = stubRubygems()
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby')), BYTES)
    assert.deepEqual(calls, [INDEX, GEM])
  })

  it("reads ~/.gem's <engine>/<ruby version> alone, not a GEM_HOME's gems/ or specs/ there", async () => {
    for (const dir of [join(HOME, '.gem', 'gems', 'evil-1.0.0'), join(HOME, '.gem', 'specs', 'rubygems.org%443'), join(HOME, '.gem', 'Ruby', '3.3.0'), join(HOME, '.gem', 'ruby', 'cache')]) {
      await plant(dir, 'gem-1.0.0.gem', BYTES)
    }
    await plant(join(HOME, '.local', 'share', 'gem', 'ruby', '3.5.0+1'), 'gem-1.0.0-x86_64-linux.gem', BYTES)
    const calls = stubRubygems()
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby')), BYTES)
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'x86_64-linux', sha256(BYTES))), BYTES)
    assert.deepEqual(calls, [INDEX, GEM])
  })

  it('reads no GEM_PATH or GEM_HOME entry that is relative, from wherever it runs', async () => {
    const cwd = process.cwd()
    const { GEM_HOME: home, GEM_PATH: path } = process.env
    try {
      await plant(join(RUBY, 'relative'), 'gem-1.0.0.gem', BYTES)
      process.chdir(RUBY)
      process.env.GEM_PATH = ['relative', '', './relative'].join(delimiter)
      process.env.GEM_HOME = 'relative'
      const calls = stubRubygems()
      assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby')), BYTES)
      assert.deepEqual(calls, [INDEX, GEM])
    } finally {
      process.chdir(cwd)
      process.env.GEM_HOME = home
      process.env.GEM_PATH = path
    }
  })

  it('reads nothing but a regular file', async () => {
    await mkdir(join(GEM_HOME, 'cache', 'gem-1.0.0.gem'), { recursive: true })
    const calls = stubRubygems()
    assert.deepEqual(new Uint8Array(await getGem('gem', '1.0.0', 'ruby')), BYTES)
    assert.deepEqual(calls, [INDEX, GEM])
  })
})
