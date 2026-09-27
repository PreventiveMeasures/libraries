import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError, cargoAdvisories, composerAdvisories } from '../advisories.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// OSV, for a fixed set of hits (`name@version` → ids) and records (id →
// record). `calls` is every request, with its parsed body.
function stubOsv(hits, records) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    const body = init.body && JSON.parse(init.body)
    calls.push({ url: String(url), body })
    if (String(url) === BATCH) {
      const results = body.queries.map(({ package: { name }, version }) => {
        const ids = hits[`${name}@${version}`] ?? []
        return ids.length > 0 ? { vulns: ids.map((id) => ({ id, modified: '2026-01-01T00:00:00Z' })) } : {}
      })
      return Promise.resolve(Response.json({ results }))
    }
    const id = String(url).slice(VULN.length)
    return Promise.resolve(Object.hasOwn(records, id) ? Response.json(records[id]) : Response.json({ code: 5, message: 'Bug not found.' }, { status: 404 }))
  }
  return calls
}

const rustsec = (id, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: ['CVE-2021-25900', 'GHSA-43w2-9j62-hq99'],
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
  affected: [{ package: { name: 'smallvec', ecosystem: 'crates.io' }, database_specific: { informational: null } }],
  ...overrides,
})

describe('cargoAdvisories', () => {
  it('reads RustSec records only, one entry per crate and record, with the versions each affects', async () => {
    const calls = stubOsv({
      'smallvec@1.6.0': ['GHSA-43w2-9j62-hq99', 'RUSTSEC-2021-0003'],
      'smallvec@0.6.10': ['RUSTSEC-2021-0003', 'RUSTSEC-2018-0018'],
      'openssl-src@111.10.0+1.1.1g': ['RUSTSEC-2021-0055'],
    }, {
      'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003'),
      'RUSTSEC-2018-0018': rustsec('RUSTSEC-2018-0018', {
        aliases: ['CVE-2018-25023', 'GHSA-55m5-whcv-c49c', 'GHSA-66p5-j55p-32r9'],
        severity: undefined,
        affected: [{ package: { name: 'smallvec', ecosystem: 'crates.io' }, database_specific: { informational: 'unsound' } }],
      }),
      'RUSTSEC-2021-0055': rustsec('RUSTSEC-2021-0055', { aliases: [], affected: [] }),
    })
    const advisories = await cargoAdvisories([
      { name: 'smallvec', version: '1.6.0' },
      { name: 'smallvec', version: '0.6.10' },
      { name: 'openssl-src', version: '111.10.0+1.1.1g' },
      { name: 'smallvec', version: '1.6.0' },
      { name: 'serde', version: '1.0.200' },
    ])
    assert.deepEqual(calls[0], {
      url: BATCH,
      body: { queries: [
        { package: { name: 'openssl-src', ecosystem: 'crates.io' }, version: '111.10.0+1.1.1g' },
        { package: { name: 'serde', ecosystem: 'crates.io' }, version: '1.0.200' },
        { package: { name: 'smallvec', ecosystem: 'crates.io' }, version: '0.6.10' },
        { package: { name: 'smallvec', ecosystem: 'crates.io' }, version: '1.6.0' },
      ] },
    })
    assert.deepEqual(calls.slice(1).map((call) => call.url).toSorted(), [`${VULN}RUSTSEC-2018-0018`, `${VULN}RUSTSEC-2021-0003`, `${VULN}RUSTSEC-2021-0055`])
    assert.deepEqual(advisories, [
      { name: 'openssl-src', id: 'RUSTSEC-2021-0055', aliases: [], title: 'Advisory RUSTSEC-2021-0055', cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', versions: ['111.10.0+1.1.1g'] },
      { name: 'smallvec', id: 'RUSTSEC-2018-0018', aliases: ['CVE-2018-25023', 'GHSA-55m5-whcv-c49c', 'GHSA-66p5-j55p-32r9'], title: 'Advisory RUSTSEC-2018-0018', informational: 'unsound', versions: ['0.6.10'] },
      { name: 'smallvec', id: 'RUSTSEC-2021-0003', ghsa: 'GHSA-43w2-9j62-hq99', aliases: ['CVE-2021-25900', 'GHSA-43w2-9j62-hq99'], title: 'Advisory RUSTSEC-2021-0003', cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', versions: ['0.6.10', '1.6.0'] },
    ])
  })

  it('leaves out a withdrawn record', async () => {
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { withdrawn: '2026-01-01T00:00:00Z' }) })
    assert.deepEqual(await cargoAdvisories([{ name: 'smallvec', version: '1.6.0' }]), [])
  })

  it('asks for 1000 packages at a time', async () => {
    const calls = stubOsv({}, {})
    const packages = Array.from({ length: 1001 }, (_, i) => ({ name: `crate${String(i).padStart(4, '0')}`, version: '1.0.0' }))
    assert.deepEqual(await cargoAdvisories(packages), [])
    assert.deepEqual(calls.map((call) => call.body.queries.length), [1000, 1])
  })

  it('makes no request for no packages', async () => {
    const calls = stubOsv({}, {})
    assert.deepEqual(await cargoAdvisories([]), [])
    assert.deepEqual(calls, [])
  })

  it('refuses a malformed crate name or version, or anything but an iterable, before any request', async () => {
    const calls = stubOsv({}, {})
    await assert.rejects(cargoAdvisories('smallvec'), /cargoAdvisories: packages must be an iterable/u)
    for (const name of ['', '1abc', '../x', 'a/b', 'a b', 'x'.repeat(65), ['smallvec'], undefined]) {
      await assert.rejects(cargoAdvisories([{ name, version: '1.0.0' }]), /cargoAdvisories: name must be a crate name/u, String(name))
    }
    for (const version of ['1.0', '^1.0.0', 'v1.0.0', '01.0.0', '1.0.0+', '1.0.0 ', '*', undefined]) {
      await assert.rejects(cargoAdvisories([{ name: 'smallvec', version }]), /cargoAdvisories: version must be a semver version/u, String(version))
    }
    assert.deepEqual(calls, [])
  })

  it('refuses an OSV answer that is malformed, cut short, or about another record', async () => {
    const one = [{ name: 'smallvec', version: '1.6.0' }]
    for (const [results, error] of [
      [[], /expected one OSV result per query/u],
      [[{ vulns: [{ id: '../x' }] }], /malformed OSV result for smallvec@1\.6\.0/u],
      [[{ vulns: [], next_page_token: 'more' }], /malformed OSV result for smallvec@1\.6\.0/u],
      [[null], /malformed OSV result for smallvec@1\.6\.0/u],
    ]) {
      globalThis.fetch = () => Promise.resolve(Response.json({ results }))
      await assert.rejects(cargoAdvisories(one), error, JSON.stringify(results))
    }
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0004') })
    await assert.rejects(cargoAdvisories(one), /cargoAdvisories: OSV answered for "RUSTSEC-2021-0004", not RUSTSEC-2021-0003/u)
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { aliases: 'CVE-2021-25900' }) })
    await assert.rejects(cargoAdvisories(one), /cargoAdvisories: malformed OSV record RUSTSEC-2021-0003/u)
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, {})
    await assert.rejects(cargoAdvisories(one), (err) => err instanceof HttpError && err.status === 404)
  })
})

describe('composerAdvisories', () => {
  const ghsa = (id, overrides = {}) => ({
    id,
    summary: `Advisory ${id}`,
    aliases: ['CVE-2025-31674', 'DRUPAL-CORE-2025-003'],
    database_specific: { severity: 'MODERATE' },
    severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:H/AT:N/PR:H/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:U' }],
    ...overrides,
  })

  it('leaves out a record that a GHSA answered for the same package also publishes', async () => {
    stubOsv({
      'drupal/core@9.5.0': ['DRUPAL-CORE-2025-003', 'GHSA-2qph-q8xw-gv7q', 'DRUPAL-CORE-2023-001'],
      'drupal/other@1.0.0': ['DRUPAL-CORE-2025-003'],
      'symfony/http-kernel@v7.4.5': ['GHSA-6439-2f28-8p8q'],
    }, {
      'GHSA-2qph-q8xw-gv7q': ghsa('GHSA-2qph-q8xw-gv7q'),
      'DRUPAL-CORE-2025-003': { id: 'DRUPAL-CORE-2025-003', aliases: ['GHSA-2qph-q8xw-gv7q'] },
      'DRUPAL-CORE-2023-001': { id: 'DRUPAL-CORE-2023-001' },
      'GHSA-6439-2f28-8p8q': ghsa('GHSA-6439-2f28-8p8q', { aliases: ['CVE-2026-45075'], database_specific: { severity: 'HIGH' }, severity: [] }),
    })
    const advisories = await composerAdvisories([
      { name: 'drupal/core', version: '9.5.0' },
      { name: 'drupal/other', version: '1.0.0' },
      { name: 'symfony/http-kernel', version: 'v7.4.5' },
    ])
    assert.deepEqual(advisories.map(({ name, id }) => `${name} ${id}`), [
      'drupal/core DRUPAL-CORE-2023-001',
      'drupal/core GHSA-2qph-q8xw-gv7q',
      'drupal/other DRUPAL-CORE-2025-003',
      'symfony/http-kernel GHSA-6439-2f28-8p8q',
    ])
    assert.deepEqual(advisories[0], { name: 'drupal/core', id: 'DRUPAL-CORE-2023-001', aliases: [], versions: ['9.5.0'] })
    assert.deepEqual(advisories[1], {
      name: 'drupal/core',
      id: 'GHSA-2qph-q8xw-gv7q',
      ghsa: 'GHSA-2qph-q8xw-gv7q',
      aliases: ['CVE-2025-31674', 'DRUPAL-CORE-2025-003'],
      title: 'Advisory GHSA-2qph-q8xw-gv7q',
      severity: 'moderate',
      cvssVector: 'CVSS:4.0/AV:N/AC:H/AT:N/PR:H/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:U',
      versions: ['9.5.0'],
    })
    assert.equal(advisories[2].ghsa, 'GHSA-2qph-q8xw-gv7q')
    assert.equal(advisories[3].severity, 'high')
  })

  it('takes Composer release versions, and refuses dev versions and malformed names, before any request', async () => {
    const calls = stubOsv({}, {})
    for (const version of ['1.2.3', 'v1.2.3', '1.2.3.4', '2.0.0-beta1', '2.0.0-RC2', '1.0.0-p1', '1.0']) {
      await composerAdvisories([{ name: 'acme/app', version }])
    }
    assert.equal(calls.length, 7)
    for (const version of ['dev-main', '2.x-dev', '1.0.0-dev', '^1.0', '1.0.0 ', '', undefined]) {
      await assert.rejects(composerAdvisories([{ name: 'acme/app', version }]), /composerAdvisories: version must be a Composer release version/u, String(version))
    }
    for (const name of ['acme', 'Acme/App', 'acme/', '/app', 'acme/app/x', '../app', 'acme/ap p', undefined]) {
      await assert.rejects(composerAdvisories([{ name, version: '1.0.0' }]), /composerAdvisories: name must be a Composer package name/u, String(name))
    }
    assert.equal(calls.length, 7)
  })
})
