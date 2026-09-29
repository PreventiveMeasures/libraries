import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { setCacheDir } from '../src/cache.js'
import { verifiedDownload } from '../src/download.js'

const CACHE_DIR = join(tmpdir(), `upstream-download-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const LOCAL = join(CACHE_DIR, 'local.tgz')
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x42])

const realFetch = globalThis.fetch
after(async () => {
  globalThis.fetch = realFetch
  await rm(CACHE_DIR, { recursive: true, force: true })
})

describe('verifiedDownload', () => {
  it('reads nothing, off disk or the network, without a hash to hold it to', async () => {
    await mkdir(join(CACHE_DIR, 'npm', 'tarballs'), { recursive: true })
    await writeFile(LOCAL, BYTES)
    await writeFile(join(CACHE_DIR, 'npm', 'tarballs', 'pkg@1.0.0.tgz'), BYTES)
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.resolve(new Response(BYTES))
    }
    const sha256 = createHash('sha256').update(BYTES).digest('hex')
    for (const [algorithm, expected] of [['sha256', undefined], ['sha256', ''], ['sha256', null], ['md5', sha256], [undefined, sha256], ['toString', sha256], ['__proto__', sha256]]) {
      const options = { method: 'm', dir: 'npm/tarballs', what: 'pkg@1.0.0', ext: 'tgz', algorithm, expected, local: [LOCAL], locate: () => 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' }
      await assert.rejects(verifiedDownload(options), /m: nothing to check pkg@1\.0\.0 against/u, `${algorithm} ${expected}`)
    }
    assert.deepEqual(calls, [])
  })
})
