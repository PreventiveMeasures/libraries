import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { afterEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const PACKAGIST = 'https://packagist.org/api/security-advisories/'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const composer = (name, versions) => ({ ecosystem: 'composer', name, versions })

// OSV and Packagist: `hits` is `name@version` -> OSV ids, `records` id ->
// record, and `packagist` name -> its advisories (a Response for the whole
// answer). `calls` is every request, Packagist's with the names it asked.
function stub({ hits = {}, records = {}, packagist = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    if (url === PACKAGIST) {
      const names = new URLSearchParams(Buffer.from(init.body).toString()).getAll('packages[]')
      calls.push({ url, method: init.method, type: init.headers?.['Content-Type'], names })
      if (packagist instanceof Response) return Promise.resolve(packagist.clone())
      const found = Object.fromEntries(names.filter((name) => Object.hasOwn(packagist, name)).map((name) => [name, packagist[name]]))
      return Promise.resolve(Response.json({ advisories: Object.keys(found).length === 0 ? [] : found }))
    }
    calls.push({ url })
    if (url === BATCH) {
      const { queries } = JSON.parse(init.body)
      return Promise.resolve(Response.json({ results: queries.map(({ package: { name }, version }) => ({ vulns: (hits[`${name}@${version}`] ?? []).map((id) => ({ id })) })) }))
    }
    if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// As Packagist answers: GitHub's, and FriendsOfPHP's, with or without a GHSA.
const advisory = (name, id, affectedVersions, overrides = {}) => ({
  advisoryId: id,
  packageName: name,
  remoteId: 'GHSA-aaaa-aaaa-aaaa',
  title: `Advisory ${id}`,
  link: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa',
  cve: 'CVE-2026-0001',
  affectedVersions,
  source: 'GitHub',
  reportedAt: '2026-01-01 00:00:00',
  composerRepository: 'https://packagist.org',
  severity: 'medium',
  sources: [{ name: 'GitHub', remoteId: 'GHSA-aaaa-aaaa-aaaa' }],
  ...overrides,
})
const friends = (name, id, affectedVersions, overrides = {}) => advisory(name, id, affectedVersions, {
  remoteId: `${name}/CVE-2026-0002.yaml`, link: 'https://symfony.com/cve-2026-0002', cve: 'CVE-2026-0002', source: 'FriendsOfPHP/security-advisories', severity: null,
  sources: [{ name: 'FriendsOfPHP/security-advisories', remoteId: `${name}/CVE-2026-0002.yaml` }], ...overrides,
})

describe('composer, from Packagist', () => {
  it('asks Packagist of every name, 100 a POST, as `composer audit` does', async () => {
    const calls = stub()
    const names = Array.from({ length: 101 }, (_, i) => `acme/pkg${String(i).padStart(3, '0')}`)
    assert.deepEqual(await advisories(names.map((name) => composer(name, ['1.0.0']))), [])
    const asked = calls.filter(({ url }) => url === PACKAGIST)
    assert.deepEqual(asked.map(({ method, type, names: chunk }) => [method, type, chunk.length]), [['POST', 'application/x-www-form-urlencoded', 100], ['POST', 'application/x-www-form-urlencoded', 1]])
    assert.deepEqual(asked.flatMap(({ names: chunk }) => chunk), names)
  })

  it("answers its advisories, by GHSA where they have one, else by PKSA, the versions matched as Composer does", async () => {
    stub({
      packagist: {
        'guzzlehttp/psr7': [advisory('guzzlehttp/psr7', 'PKSA-vznr-tgp9-fd7d', '>=2.0.0,<2.4.5|<1.9.1')],
        'symfony/http-kernel': [
          friends('symfony/http-kernel', 'PKSA-dw7n-x7f5-zf63', '>=7.4.0,<7.4.12|>=8.0.0-RC1,<8.0.12', { cve: null }),
          // FriendsOfPHP's alone, its GHSA only in its link; one Composer can't read covers every version.
          friends('symfony/http-kernel', 'PKSA-3gxv-7xhq-mgmz', 'not a constraint', { link: 'https://github.com/symfony/symfony/security/advisories/GHSA-wg5q-m2ww-f3c9', cve: null }),
        ],
      },
    })
    const found = await advisories([composer('guzzlehttp/psr7', ['1.9.0', 'v1.9.1', '2.4.4.0', '2.4.5']), composer('symfony/http-kernel', ['v7.4.11', '7.4.12', '8.0.0-RC2', '8.1.0'])])
    assert.deepEqual(found, [
      {
        ecosystem: 'composer',
        name: 'guzzlehttp/psr7',
        source: 'packagist',
        id: 'GHSA-aaaa-aaaa-aaaa',
        ghsa: 'GHSA-aaaa-aaaa-aaaa',
        url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa',
        aliases: ['PKSA-vznr-tgp9-fd7d', 'CVE-2026-0001'],
        title: 'Advisory PKSA-vznr-tgp9-fd7d',
        severity: 'moderate',
        cwe: [],
        range: '>=2.0.0,<2.4.5|<1.9.1',
        versions: ['1.9.0', '2.4.4.0'],
      },
      {
        ecosystem: 'composer',
        name: 'symfony/http-kernel',
        source: 'packagist',
        id: 'PKSA-dw7n-x7f5-zf63',
        url: 'https://symfony.com/cve-2026-0002',
        aliases: [],
        title: 'Advisory PKSA-dw7n-x7f5-zf63',
        cwe: [],
        range: '>=7.4.0,<7.4.12|>=8.0.0-RC1,<8.0.12',
        versions: ['8.0.0-RC2', 'v7.4.11'],
      },
      {
        ecosystem: 'composer',
        name: 'symfony/http-kernel',
        source: 'packagist',
        id: 'GHSA-wg5q-m2ww-f3c9',
        ghsa: 'GHSA-wg5q-m2ww-f3c9',
        url: 'https://github.com/symfony/symfony/security/advisories/GHSA-wg5q-m2ww-f3c9',
        aliases: ['PKSA-3gxv-7xhq-mgmz'],
        title: 'Advisory PKSA-3gxv-7xhq-mgmz',
        cwe: [],
        range: 'not a constraint',
        versions: ['7.4.12', '8.0.0-RC2', '8.1.0', 'v7.4.11'],
      },
    ])
  })

  it("is one row with OSV's of the same GHSA, or of a record naming its PKSA or CVE", async () => {
    stub({
      hits: { 'acme/app@1.0.0': ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb'] },
      records: {
        'GHSA-aaaa-aaaa-aaaa': { id: 'GHSA-aaaa-aaaa-aaaa', aliases: ['CVE-2026-0001'], summary: 'From OSV', database_specific: { severity: 'HIGH' } },
        'GHSA-bbbb-bbbb-bbbb': { id: 'GHSA-bbbb-bbbb-bbbb', aliases: ['CVE-2026-0002', 'PKSA-bbbb-bbbb-bbbb'], summary: 'From OSV too' },
      },
      packagist: {
        'acme/app': [
          advisory('acme/app', 'PKSA-aaaa-aaaa-aaaa', '<2.0.0'),
          friends('acme/app', 'PKSA-bbbb-bbbb-bbbb', '<1.5.0'),
        ],
      },
    })
    const found = await advisories([composer('acme/app', ['1.0.0', '1.2.0'])])
    assert.deepEqual(found.map(({ source, id, aliases, title, severity, range, versions }) => [source, id, aliases, title, severity, range, versions]), [
      ['osv', 'GHSA-aaaa-aaaa-aaaa', ['CVE-2026-0001', 'PKSA-aaaa-aaaa-aaaa'], 'From OSV', 'high', '<2.0.0', ['1.0.0', '1.2.0']],
      ['osv', 'GHSA-bbbb-bbbb-bbbb', ['CVE-2026-0002', 'PKSA-bbbb-bbbb-bbbb'], 'From OSV too', undefined, '<1.5.0', ['1.0.0', '1.2.0']],
    ])
  })

  it('throws on a malformed answer, or one about a package not asked', async () => {
    const one = [composer('acme/app', ['1.0.0'])]
    stub({ packagist: Response.json({ results: [] }) })
    await assert.rejects(advisories(one), /advisories: expected an object of advisories from Packagist/u)
    stub({ packagist: Response.json({ advisories: { 'acme/other': [] } }) })
    await assert.rejects(advisories(one), /advisories: Packagist answered for "acme\/other", which was not asked/u)
    for (const bad of [{ advisoryId: 'GHSA-aaaa-aaaa-aaaa' }, { packageName: 'acme/other' }, { title: 7 }, { affectedVersions: null }, { sources: [{ name: 'GitHub' }] }]) {
      stub({ packagist: { 'acme/app': [advisory('acme/app', 'PKSA-aaaa-aaaa-aaaa', '<2.0.0', bad)] } })
      await assert.rejects(advisories(one), /advisories: malformed advisories from Packagist for acme\/app/u, JSON.stringify(bad))
    }
    stub({ packagist: Response.json({ error: 'busy' }, { status: 503 }) })
    await assert.rejects(advisories(one), { name: 'HttpError', status: 503 })
  })
})
