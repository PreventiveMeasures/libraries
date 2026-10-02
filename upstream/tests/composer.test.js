import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { getDist } from '../composer.js'
import { setCacheDir } from '../npm.js'
import { SHA, forbidRequests, json, stubGitHub } from './github-stub.js'

const CACHE_DIR = join(tmpdir(), `upstream-composer-test-${process.pid}`)
setCacheDir(CACHE_DIR)
const DISTS = join(CACHE_DIR, 'composer', 'dists')

const realFetch = globalThis.fetch
const ZIP = new TextEncoder().encode('PK\u0005\u0006 a zip')
const SHASUM = createHash('sha1').update(ZIP).digest('hex')
const DRUPAL = 'https://ftp.drupal.org/files/projects/admin_toolbar-3.6.3.zip'
const GITHUB = `https://api.github.com/repos/acme/app/zipball/${SHA}`

const serve = (files) => stubGitHub(({ url }) => (Object.hasOwn(files, url) ? new Response(files[url]) : json({ message: 'Not Found' }, 404)))

beforeEach(() => rm(CACHE_DIR, { recursive: true, force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => rm(CACHE_DIR, { recursive: true, force: true }))

describe('getDist', () => {
  it('fetches a drupal.org release zip, held to its sha1, and caches it by the sha1', async () => {
    const calls = serve({ [DRUPAL]: ZIP })
    assert.deepEqual(await getDist(DRUPAL, SHASUM), ZIP)
    assert.deepEqual(calls.map(({ url, redirect }) => [url, redirect]), [[DRUPAL, 'manual']])
    assert.deepEqual(await readdir(DISTS), [`${SHASUM}.zip`])
    const again = forbidRequests()
    assert.deepEqual(await getDist(DRUPAL, SHASUM), ZIP)
    assert.deepEqual(again, [])
  })

  it("fetches GitHub's zipball of a commit, following its redirect", async () => {
    const calls = serve({ [GITHUB]: ZIP })
    assert.deepEqual(await getDist(GITHUB, SHASUM), ZIP)
    assert.deepEqual(calls.map(({ url, redirect, headers }) => [url, redirect, headers]), [[GITHUB, 'follow', {}]])
  })

  it('refuses bytes of another sha1, downloaded or cached', async () => {
    serve({ [DRUPAL]: ZIP })
    await assert.rejects(getDist(DRUPAL, 'f'.repeat(40)), new RegExp(`getDist: integrity mismatch for f{40} from ${DRUPAL.replaceAll('.', '\\.')}: expected f{40}, got ${SHASUM}$`, 'u'))
    assert.deepEqual(await readdir(DISTS).catch(() => []), [])
    await getDist(DRUPAL, SHASUM)
    await writeFile(join(DISTS, `${SHASUM}.zip`), 'other')
    await assert.rejects(getDist(DRUPAL, SHASUM), /getDist: integrity mismatch for [\da-f]{40} from the cache/u)
  })

  it('takes only those two kinds of URL, and a sha1 in lowercase hex, before any request', async () => {
    const calls = forbidRequests()
    for (const url of [
      'http://ftp.drupal.org/files/projects/a-1.0.zip', 'https://ftp.drupal.org/files/projects/a-1.0.tar.gz', 'https://ftp.drupal.org/files/projects/../a-1.0.zip',
      'https://ftp.drupal.org/files/projects/a%20b.zip', 'https://ftp.drupal.org/files/a-1.0.zip', 'https://ftp.drupal.org/files/projects/.zip',
      `https://api.github.com/repos/acme/app/zipball/main`, `https://api.github.com/repos/acme/app/tarball/${SHA}`, `https://api.github.com/repos/acme/app/zipball/${SHA}?x=1`,
      `https://api.github.com/repos/acme/../zipball/${SHA}`, `https://codeload.github.com/acme/app/legacy.zip/${SHA}`, `https://user:pw@ftp.drupal.org/files/projects/a-1.0.zip`,
      'https://repo.packagist.org/files/a-1.0.zip', undefined, 42,
    ]) {
      await assert.rejects(getDist(url, SHASUM), /getDist: url must be a release zip on ftp\.drupal\.org or a GitHub zipball of a commit/u, String(url))
    }
    for (const shasum of [undefined, '', SHASUM.toUpperCase(), `${SHASUM}0`, 'g'.repeat(40)]) {
      await assert.rejects(getDist(DRUPAL, shasum), /getDist: shasum must be a sha1 in lowercase hex/u, String(shasum))
    }
    assert.deepEqual(calls, [])
  })
})
