import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, beforeEach, describe, it } from 'node:test'

// A file of its own, since defaultCacheDir is read from the environment
// once, when the module is first imported: the environment is this file's
// before it is, and every cache it names is under LOCAL.
const LOCAL = join(tmpdir(), `upstream-cache-dir-test-${process.pid}`)
const HOME = join(LOCAL, 'home')
const XDG = join(LOCAL, 'xdg')
process.env.HOME = HOME
process.env.XDG_CACHE_HOME = XDG
process.env.LOCALAPPDATA = join(LOCAL, 'local')
process.env.npm_config_cache = join(LOCAL, 'npm-cache')
delete process.env.NPM_CONFIG_CACHE

const { cacheDirFor, defaultCacheDir, getTarball, setCacheDir } = await import('../npm.js')
const { readCache, writeCache } = await import('../src/cache.js')

const realFetch = globalThis.fetch
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const ENV = { ...process.env }

beforeEach(async () => {
  await rm(LOCAL, { recursive: true, force: true })
  globalThis.fetch = realFetch
  setCacheDir(false)
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(LOCAL, { recursive: true, force: true })
})

// As if on `platform`, with the environment changed by `env` (undefined
// deletes), for the length of `call`.
function on(platform, env, call) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return call()
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
    for (const name of Object.keys(env)) {
      if (ENV[name] === undefined) delete process.env[name]
      else process.env[name] = ENV[name]
    }
  }
}

// os.homedir() reads USERPROFILE on Windows, not HOME.
describe('cacheDirFor', { skip: process.platform === 'win32' }, () => {
  it('follows XDG_CACHE_HOME where it is absolute, else ~/.cache', () => {
    assert.equal(on('linux', {}, () => cacheDirFor('tool')), join(XDG, 'tool'))
    assert.equal(on('freebsd', {}, () => cacheDirFor('tool')), join(XDG, 'tool'))
    for (const xdg of [undefined, '', 'relative/cache']) {
      assert.equal(on('linux', { XDG_CACHE_HOME: xdg }, () => cacheDirFor('tool')), join(HOME, '.cache', 'tool'), String(xdg))
    }
  })

  it('takes ~/Library/Caches on macOS, whatever XDG_CACHE_HOME says', () => {
    assert.equal(on('darwin', {}, () => cacheDirFor('Tool')), join(HOME, 'Library', 'Caches', 'Tool'))
  })

  it('takes %LOCALAPPDATA%\\<name>\\Cache on Windows, where it is absolute', () => {
    assert.equal(on('win32', {}, () => cacheDirFor('tool')), join(LOCAL, 'local', 'tool', 'Cache'))
    for (const local of [undefined, '', 'relative']) {
      assert.equal(on('win32', { LOCALAPPDATA: local }, () => cacheDirFor('tool')), join(HOME, 'AppData', 'Local', 'tool', 'Cache'), String(local))
    }
  })

  it('answers undefined where no absolute directory is there to start from', () => {
    assert.equal(on('linux', { XDG_CACHE_HOME: undefined, HOME: 'relative' }, () => cacheDirFor('tool')), undefined)
    assert.equal(on('darwin', { HOME: 'relative' }, () => cacheDirFor('tool')), undefined)
    assert.equal(on('linux', { HOME: 'relative' }, () => cacheDirFor('tool')), join(XDG, 'tool'), 'XDG_CACHE_HOME needs no home')
  })

  it('takes one directory name, and nothing else', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\nb', 1, undefined]) {
      assert.throws(() => cacheDirFor(name), /^AssertionError.*cacheDirFor: name must be a directory name/u, String(name))
    }
    assert.equal(on('linux', {}, () => cacheDirFor('.hidden')), join(XDG, '.hidden'))
  })
})

describe('setCacheDir', () => {
  it('caches nothing until it is called', async () => {
    assert.equal(defaultCacheDir, join(XDG, 'PreventiveMeasures'))
    assert.equal(await writeCache('npm/repos', 'x.json', '{}'), false)
    assert.deepEqual(await readdir(LOCAL).catch(() => []), [])
  })

  it('caches in defaultCacheDir where given nothing, and nowhere for false', async () => {
    setCacheDir()
    assert.equal(await writeCache('npm/repos', 'x.json', '{}'), true)
    assert.deepEqual(await readdir(join(defaultCacheDir, 'npm', 'repos')), ['x.json'])
    setCacheDir(false)
    assert.equal(await readCache('npm/repos', 'x.json'), null)
    assert.equal(await writeCache('npm/repos', 'y.json', '{}'), false)
    for (const dir of ['', 0, null, true]) assert.throws(() => setCacheDir(dir), /setCacheDir: dir must be a directory path/u)
  })

  it('throws where there is no default to cache in', () => {
    const script = "const { setCacheDir, defaultCacheDir } = await import('./npm.js'); try { setCacheDir() } catch (e) { console.log(defaultCacheDir, e.message) }"
    const env = { ...process.env, HOME: 'relative', XDG_CACHE_HOME: '', USERPROFILE: '', LOCALAPPDATA: '' }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' })
    assert.equal(r.stdout, 'undefined setCacheDir: there is no default cache directory, as no absolute home directory is known: give one\n')
  })
})

describe('getTarball reads our caches, set or not', () => {
  const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x42])
  const DOC = 'https://registry.npmjs.org/pkg/1.0.0'
  const TARBALL = 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz'
  const integrity = `sha512-${createHash('sha512').update(BYTES).digest('base64')}`
  const filed = (base) => join(base, 'npm', 'tarballs', 'pkg@1.0.0.tgz')
  const plant = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  const stub = () => {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      if (String(url) === DOC) return Promise.resolve(Response.json({ name: 'pkg', version: '1.0.0', dist: { tarball: TARBALL, integrity } }))
      if (String(url) === TARBALL) return Promise.resolve(new Response(BYTES))
      return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    }
    return calls
  }

  for (const name of ['PreventiveMeasures', 'stasis']) {
    it(`reads cacheDirFor(${JSON.stringify(name)}) with no cache set, and with another set`, async () => {
      for (const set of [false, join(LOCAL, 'elsewhere')]) {
        setCacheDir(set)
        await plant(filed(cacheDirFor(name)), BYTES)
        const calls = stub()
        assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
        assert.deepEqual(calls, [DOC], String(set))
        await rm(LOCAL, { recursive: true, force: true })
      }
    })
  }

  it('passes over bytes there that do not match, but for the cache set', async () => {
    await plant(filed(defaultCacheDir), new Uint8Array([...BYTES, 0]))
    await plant(filed(cacheDirFor('stasis')), new Uint8Array([...BYTES, 0]))
    let calls = stub()
    assert.deepEqual(new Uint8Array(await getTarball('pkg', '1.0.0')), BYTES)
    assert.deepEqual(calls, [DOC, TARBALL])
    setCacheDir()
    calls = stub()
    await assert.rejects(getTarball('pkg', '1.0.0'), /getTarball: integrity mismatch for pkg@1\.0\.0 from the cache/u)
    assert.deepEqual(calls, [DOC])
  })

  it('writes nothing to them unless set', async () => {
    stub()
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(await readdir(LOCAL).catch(() => []), [])
    setCacheDir()
    await getTarball('pkg', '1.0.0')
    assert.deepEqual(await readdir(join(defaultCacheDir, 'npm', 'tarballs')), ['pkg@1.0.0.tgz'])
  })
})
