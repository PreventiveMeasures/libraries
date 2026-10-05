import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { readCache, readCacheJSON, readRegularFile, setCacheDir, writeCache, writeCacheJSON } from '../src/cache.js'

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

  it('keeps keys apart only in case apart where case is not told apart, a capital written `!` and the letter', async () => {
    const keys = { 'JSONStream@1.0.3.tgz': '!j!s!o!n!stream@1.0.3.tgz', 'jsonstream@1.0.3.tgz': 'jsonstream@1.0.3.tgz', 'x@1.0.0-RC1.crate': 'x@1.0.0-!r!c1.crate', 'x@1.0.0-rc1.crate': 'x@1.0.0-rc1.crate', '!x@1.0.0.crate': '!!x@1.0.0.crate', 'X@1.0.0.crate': '!x@1.0.0.crate' }
    for (const [i, key] of Object.keys(keys).entries()) assert.equal(await writeCache('cargo/crates', key, new Uint8Array([i])), true)
    const names = await readdir(join(base, 'cache', 'cargo', 'crates'))
    assert.deepEqual(names.toSorted(), Object.values(keys).toSorted())
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length)
    for (const [i, key] of Object.keys(keys).entries()) assert.deepEqual(await readCache('cargo/crates', key), new Uint8Array([i]), key)
  })

  it('escapes the first letter of a Windows device name, and of nothing else', async () => {
    const keys = { 'con.json': '%63on.json', 'nul.json': '%6Eul.json', 'aux.json': '%61ux.json', 'prn.json': '%70rn.json', 'com1.json': '%63om1.json', 'lpt9.json': '%6Cpt9.json', 'con': '%63on', 'Con.json': '!con.json', 'console.json': 'console.json', 'con@1.0.0.json': 'con@1.0.0.json', 'com10.json': 'com10.json' }
    for (const [i, key] of Object.keys(keys).entries()) assert.equal(await writeCacheJSON('cargo/repos', key, { i }), true)
    assert.deepEqual((await readdir(join(base, 'cache', 'cargo', 'repos'))).toSorted(), Object.values(keys).toSorted())
    for (const [i, key] of Object.keys(keys).entries()) assert.deepEqual(await readCacheJSON('cargo/repos', key), { i }, key)
  })

  it('reads nothing but a regular file, and a FIFO without waiting on it', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const dir = join(base, 'cache', 'soldeer', 'zips')
    await mkdir(join(dir, 'dir@1.0.0.zip'), { recursive: true })
    execFileSync('mkfifo', [join(dir, 'fifo@1.0.0.zip')])
    assert.equal(await readCache('soldeer/zips', 'dir@1.0.0.zip'), null)
    assert.equal(await readCache('soldeer/zips', 'fifo@1.0.0.zip'), null)
    assert.equal(await readRegularFile('/dev/zero'), null)
    assert.equal(await readRegularFile(join(dir, 'missing@1.0.0.zip')), null)
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

  // Left out, it is the default directory; false, none (cache-dir.test.js).
  it('refuses a cache directory that is not a path', () => {
    for (const dir of ['', 42, null, true, 'a\u0000b']) assert.throws(() => setCacheDir(dir), /setCacheDir: dir must be a directory path/u, String(dir))
  })
})
