import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { readCache, readCacheJSON, setCacheDir, writeCache, writeCacheJSON } from '../src/cache.js'

// A file of its own, since the cache directory is process-wide.

const base = await mkdtemp(join(tmpdir(), 'upstream-cache-test-'))
const home = process.cwd()

after(async () => {
  process.chdir(home)
  await rm(base, { recursive: true, force: true })
})

describe('the cache', () => {
  it('holds a relative directory to where it was when set', async () => {
    process.chdir(base)
    setCacheDir('cache')
    assert.equal(await writeCacheJSON('npm/repos', 'lodash.json', { a: 1 }), true)
    process.chdir(home)
    assert.deepEqual(await readCacheJSON('npm/repos', 'lodash.json'), { a: 1 })
    assert.deepEqual(await readdir(join(base, 'cache', 'npm', 'repos')), ['lodash.json'])
  })

  it('keeps a key to one file, whatever is in it', async () => {
    assert.equal(await writeCache('npm/tarballs', '../../escape@1.0.0.tgz', new Uint8Array([1])), true)
    assert.deepEqual(await readdir(join(base, 'cache', 'npm', 'tarballs')), ['..+..+escape@1.0.0.tgz'])
    assert.deepEqual(await readCache('npm/tarballs', '../../escape@1.0.0.tgz'), new Uint8Array([1]))
  })

  it('names a file as pnpm would, `@` kept and `/` written `+`, and a `+` of its own apart', async () => {
    assert.equal(await writeCacheJSON('composer/repos', 'monolog/monolog.json', { a: 1 }), true)
    assert.equal(await writeCacheJSON('composer/repos', 'monolog+monolog.json', { a: 2 }), true)
    assert.deepEqual((await readdir(join(base, 'cache', 'composer', 'repos'))).toSorted(), ['monolog%2Bmonolog.json', 'monolog+monolog.json'])
    assert.deepEqual(await readCacheJSON('composer/repos', 'monolog/monolog.json'), { a: 1 })
    assert.deepEqual(await readCacheJSON('composer/repos', 'monolog+monolog.json'), { a: 2 })
  })

  it('reads a record that is not UTF-8 as a miss', async () => {
    assert.equal(await writeCache('npm/repos', 'bad.json', new Uint8Array([0x22, 0xFF, 0x22])), true)
    assert.equal(await readCacheJSON('npm/repos', 'bad.json'), null)
  })

  it('files records only under the kinds it keeps', async () => {
    await assert.rejects(writeCache('../etc', 'x', ''), /Unexpected cache entry/u)
    await assert.rejects(readCache('npm', 'x'), /Unexpected cache entry/u)
    await assert.rejects(readCacheJSON('npm/repos', ''), /Unexpected cache entry/u)
  })

  it('answers false for a write it could not make, and leaves no temp file behind', async () => {
    // A non-empty directory where the record would go: the rename fails.
    await mkdir(join(base, 'cache', 'npm', 'repos', 'taken.json', 'inside'), { recursive: true })
    assert.equal(await writeCacheJSON('npm/repos', 'taken.json', { a: 1 }), false)
    assert.deepEqual((await readdir(join(base, 'cache', 'npm', 'repos'))).filter((name) => name.endsWith('.tmp')), [])
    assert.equal(await readCacheJSON('npm/repos', 'taken.json'), null)
  })

  it('refuses a cache directory that is not a path', () => {
    for (const dir of ['', 42, undefined, 'a\u0000b']) assert.throws(() => setCacheDir(dir), /setCacheDir: dir must be a directory path/u, String(dir))
  })
})
