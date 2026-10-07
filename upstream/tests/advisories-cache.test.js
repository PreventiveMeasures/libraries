import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'

// A file of its own, since the cache directory is process-wide.

const dir = await mkdtemp(join(tmpdir(), 'upstream-advisories-cache-'))
const LISTINGS = join(dir, 'github', 'advisories')
const FILE = join(LISTINGS, 'openzeppelin+openzeppelin-contracts.json.gz')
const readEntry = async () => JSON.parse(gunzipSync(await readFile(FILE)))
const MINUTE = 60 * 1000
const realFetch = globalThis.fetch

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true })
  setCacheDir(dir)
  globalThis.fetch = realFetch
})

after(async () => {
  globalThis.fetch = realFetch
  await rm(dir, { recursive: true, force: true })
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const OZ = listing('OpenZeppelin/openzeppelin-contracts')
const vuln = (name, range) => ({ package: { ecosystem: 'npm', name }, vulnerable_version_range: range })
// As GitHub lists one, with what no row is made from.
const advisory = (ghsa, vulnerabilities, overrides = {}) => ({
  ghsa_id: ghsa,
  state: 'published',
  summary: `Advisory ${ghsa}`,
  description: `Details of ${ghsa}.`,
  severity: 'medium',
  cwe_ids: ['CWE-79'],
  cvss_severities: { cvss_v3: { vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', score: 6.1 }, cvss_v4: { vector_string: null, score: null } },
  author: { login: 'someone', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  credits_detailed: [{ user: { login: 'finder' }, type: 'reporter' }],
  vulnerabilities,
  ...overrides,
})
const LIST = [
  advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3'), { package: null, vulnerable_version_range: null }]),
  advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '< 9.0.0')], { withdrawn_at: '2026-01-01T00:00:00Z' }),
]

// Answers each URL in `answers`, a Response as is and anything else as
// JSON, and refuses any other; `calls` is every URL asked.
function stubUrls(answers) {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    const answer = answers[String(url)]
    if (answer === undefined) return Promise.reject(new Error(`unexpected request: ${url}`))
    return Promise.resolve(answer instanceof Response ? answer.clone() : Response.json(answer))
  }
  return calls
}

const audit = (name = 'OpenZeppelin/openzeppelin-contracts', options = {}) => advisories([{ ecosystem: 'github', name, versions: ['4.9.0'] }], { github, ...options })

describe("a repository's listing, through the cache", () => {
  it('is kept for 90 minutes, digested, and answers as GitHub did, details and all', async () => {
    let calls = stubUrls({ [OZ]: LIST })
    const fresh = await audit(undefined, { details: true })
    assert.deepEqual(calls, [OZ])
    calls = stubUrls({})
    assert.deepEqual(await audit(undefined, { details: true }), fresh)
    assert.deepEqual(await audit(), fresh.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'details'))))
    assert.deepEqual(calls, [])
    assert.equal(fresh[0].details, 'Details of GHSA-aaaa-aaaa-aaaa.')
    // Only what rows are made from: no withdrawn advisory, no author.
    assert.deepEqual(await readdir(LISTINGS), ['openzeppelin+openzeppelin-contracts.json.gz'])
    const entry = await readEntry()
    // gzip's output is deterministic: these are the bytes of its default level.
    assert.deepEqual(await readFile(FILE), gzipSync(JSON.stringify(entry)))
    await writeFile(FILE, gzipSync(JSON.stringify({ ...entry, at: Date.now() - 89 * MINUTE })))
    assert.deepEqual(await audit(), fresh.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'details'))))
    assert.deepEqual(calls, [], 'still fresh at 89 minutes')
    assert.deepEqual({ ...entry, at: 0 }, {
      at: 0,
      name: 'openzeppelin/openzeppelin-contracts',
      v: 1,
      advisories: [{
        ghsa: 'GHSA-aaaa-aaaa-aaaa', title: 'Advisory GHSA-aaaa-aaaa-aaaa', description: 'Details of GHSA-aaaa-aaaa-aaaa.',
        severity: 'moderate', cvss: 6.1, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe: ['CWE-79'],
        ranges: [{ range: '>= 4.0.0, < 4.9.3', ecosystem: 'npm', name: '@openzeppelin/contracts' }, { range: '' }],
      }],
    })
  })

  it('answers every spelling of the repository from one entry, each with its own page', async () => {
    stubUrls({ [OZ]: LIST })
    await audit()
    const calls = stubUrls({})
    const found = await audit('openzeppelin/OpenZeppelin-Contracts')
    assert.deepEqual(calls, [])
    assert.equal(found[0].url, 'https://github.com/openzeppelin/OpenZeppelin-Contracts/security/advisories/GHSA-aaaa-aaaa-aaaa')
  })

  it('asks again past 90 minutes, for an entry dated in the future, kept differently, or not gzip, cut short or damaged', async () => {
    stubUrls({ [OZ]: LIST })
    await audit()
    const entry = await readEntry()
    const gzip = (value) => gzipSync(JSON.stringify(value))
    // Its CRC-32 a bit off: what decodes is the entry as it was, and the
    // file a miss all the same.
    const damaged = gzip(entry)
    damaged[damaged.length - 8] ^= 1
    for (const [i, stale] of [
      gzip({ ...entry, at: Date.now() - 91 * MINUTE }),
      gzip({ ...entry, at: Date.now() + 60_000 }),
      gzip({ ...entry, v: 0 }),
      gzip({ ...entry, name: 'acme/other' }),
      gzip({ ...entry, advisories: [{ ...entry.advisories[0], ranges: [{ range: 42 }] }] }),
      gzip({ ...entry, advisories: [{ ...entry.advisories[0], description: 42 }] }),
      gzip({ ...entry, advisories: {} }),
      JSON.stringify(entry),
      gzip(entry).subarray(0, 20),
      damaged,
    ].entries()) {
      await writeFile(FILE, stale)
      const calls = stubUrls({ [OZ]: [] })
      assert.deepEqual(await audit(), [], String(i))
      assert.deepEqual(calls, [OZ])
    }
  })

  it('keeps no listing of a repository gone, nor one malformed', async () => {
    stubUrls({ [OZ]: Response.json({ message: 'Not Found' }, { status: 404 }) })
    assert.deepEqual(await audit(), [])
    stubUrls({ [OZ]: [{ ...LIST[0], state: 'draft' }] })
    await assert.rejects(audit(), /advisories: malformed advisory from OpenZeppelin\/openzeppelin-contracts/u)
    stubUrls({ [OZ]: [{ ...LIST[0], vulnerabilities: [{ vulnerable_version_range: 42 }] }] })
    await assert.rejects(audit(), /advisories: malformed range in GHSA-aaaa-aaaa-aaaa/u)
    stubUrls({ [OZ]: Response.json({ message: 'rate limited' }, { status: 403 }) })
    await assert.rejects(audit(), { name: 'HttpError', status: 403 })
    // Text is checked only for `details`: the listing answers without it,
    // and is asked again for it.
    const calls = stubUrls({ [OZ]: [{ ...LIST[0], description: 'a\uD800b' }] })
    assert.equal((await audit()).length, 2)
    await assert.rejects(audit(undefined, { details: true }), /advisories: malformed details in GHSA-aaaa-aaaa-aaaa/u)
    assert.deepEqual(calls, [OZ, OZ])
    assert.deepEqual(await readdir(dir).catch(() => []), [])
  })

  it('is asked every time with no cache set', async () => {
    setCacheDir(false)
    for (let i = 0; i < 2; i++) {
      const calls = stubUrls({ [OZ]: LIST })
      assert.equal((await audit()).length, 2)
      assert.deepEqual(calls, [OZ])
    }
    assert.deepEqual(await readdir(dir).catch(() => []), [])
  })
})

describe("a caller's store", () => {
  // A store over a Map, keeping what it is given as JSON by type and key,
  // as a database would; `log` is every read and write.
  const TYPE = 'github/advisories'
  const KEY = 'openzeppelin/openzeppelin-contracts'
  function mapStore() {
    const entries = new Map()
    const log = []
    const at = (type, key) => JSON.stringify([type, key])
    return {
      log,
      get: (type, key) => entries.get(at(type, key)),
      set: (type, key, value) => entries.set(at(type, key), JSON.stringify(value)),
      read(type, key) {
        log.push(['read', type, key])
        return Promise.resolve(entries.has(at(type, key)) ? JSON.parse(entries.get(at(type, key))) : undefined)
      },
      write(type, key, value) {
        log.push(['write', type, key])
        entries.set(at(type, key), JSON.stringify(value))
        return Promise.resolve()
      },
    }
  }

  it('keeps listings in place of the directory, by their type and the repository in lowercase', async () => {
    const store = mapStore()
    let calls = stubUrls({ [OZ]: LIST })
    const fresh = await audit(undefined, { cache: store, details: true })
    assert.deepEqual(calls, [OZ])
    assert.deepEqual(store.log, [['read', TYPE, KEY], ['write', TYPE, KEY]])
    const entry = JSON.parse(store.get(TYPE, KEY))
    assert.deepEqual([entry.name, entry.v, entry.advisories.map(({ ghsa }) => ghsa)], ['openzeppelin/openzeppelin-contracts', 1, ['GHSA-aaaa-aaaa-aaaa']])
    calls = stubUrls({})
    const respelled = (text) => text.replace('OpenZeppelin/openzeppelin-contracts', 'openzeppelin/OpenZeppelin-Contracts')
    assert.deepEqual(await audit('openzeppelin/OpenZeppelin-Contracts', { cache: store, details: true }), fresh.map((row) => ({ ...row, name: respelled(row.name), url: respelled(row.url) })))
    assert.deepEqual(calls, [])
    assert.deepEqual(await readdir(dir).catch(() => []), [], 'nothing on disk')
  })

  it('takes what the store does not have, or has stale or malformed, as a miss', async () => {
    const store = mapStore()
    const kept = { ghsa: 'GHSA-aaaa-aaaa-aaaa', title: 'Advisory', ranges: [] }
    const entry = (at, list) => ({ at, name: 'openzeppelin/openzeppelin-contracts', v: 1, advisories: list })
    for (const stored of [null, 'text', entry(Date.now() - 91 * MINUTE, []), entry(Date.now(), [{ ...kept, description: 42 }])]) {
      store.set(TYPE, KEY, stored)
      const calls = stubUrls({ [OZ]: [] })
      assert.deepEqual(await audit(undefined, { cache: store }), [])
      assert.deepEqual(calls, [OZ])
    }
  })

  it("passes on the store's own failures", async () => {
    stubUrls({ [OZ]: LIST })
    await assert.rejects(audit(undefined, { cache: { read: () => Promise.reject(new Error('read failed')), write: () => Promise.resolve() } }), /read failed/u)
    await assert.rejects(audit(undefined, { cache: { read: () => Promise.resolve(null), write: () => Promise.reject(new Error('write failed')) } }), /write failed/u)
  })

  it('refuses what is not a store, before any request', async () => {
    const calls = stubUrls({})
    for (const cache of [null, {}, { read() {} }, 'dir']) {
      await assert.rejects(audit(undefined, { cache }), /advisories: cache must be a store with read and write/u, String(cache))
    }
    assert.deepEqual(calls, [])
  })
})
