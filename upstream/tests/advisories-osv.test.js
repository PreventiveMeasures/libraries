import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

import { HttpError, advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// `{ name, version }` pairs as the packages advisories takes.
const as = (ecosystem) => (pairs, options) => advisories(pairs.map(({ name, version, ...rest }) => ({ ecosystem, name, versions: [version], ...rest })), options)
const cargo = as('cargo')
const composer = as('composer')

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

const ghsa = (id, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: ['CVE-2025-31674', 'DRUPAL-CORE-2025-003'],
  database_specific: { severity: 'MODERATE', cwe_ids: ['CWE-913'] },
  severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:H/AT:N/PR:H/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:U' }],
  ...overrides,
})

describe('cargo', () => {
  it('answers one entry per crate and record, with the versions each affects, RustSec standing for the GHSA it is published as', async () => {
    const calls = stubOsv({
      'smallvec@1.6.0': ['GHSA-43w2-9j62-hq99', 'RUSTSEC-2021-0003'],
      'smallvec@0.6.10': ['RUSTSEC-2021-0003', 'RUSTSEC-2018-0018'],
      'openssl-src@111.10.0+1.1.1g': ['RUSTSEC-2021-0055'],
    }, {
      'GHSA-43w2-9j62-hq99': { id: 'GHSA-43w2-9j62-hq99', aliases: ['CVE-2021-25900', 'RUSTSEC-2021-0003'], summary: 'Advisory GHSA-43w2-9j62-hq99' },
      'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003'),
      'RUSTSEC-2018-0018': rustsec('RUSTSEC-2018-0018', {
        aliases: ['CVE-2018-25023', 'GHSA-55m5-whcv-c49c', 'GHSA-66p5-j55p-32r9'],
        severity: undefined,
        affected: [{ package: { name: 'smallvec', ecosystem: 'crates.io' }, database_specific: { informational: 'unsound' } }],
      }),
      'RUSTSEC-2021-0055': rustsec('RUSTSEC-2021-0055', { aliases: [], affected: [] }),
    })
    const found = await cargo([
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
    assert.deepEqual(calls.slice(1).map((call) => call.url).toSorted(), [`${VULN}GHSA-43w2-9j62-hq99`, `${VULN}RUSTSEC-2018-0018`, `${VULN}RUSTSEC-2021-0003`, `${VULN}RUSTSEC-2021-0055`])
    const common = { ecosystem: 'cargo', source: 'osv', cwe: [] }
    assert.deepEqual(found, [
      { ...common, name: 'openssl-src', id: 'RUSTSEC-2021-0055', url: 'https://osv.dev/vulnerability/RUSTSEC-2021-0055', aliases: [], title: 'Advisory RUSTSEC-2021-0055', cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', versions: ['111.10.0+1.1.1g'] },
      {
        ...common, name: 'smallvec', id: 'RUSTSEC-2018-0018', url: 'https://osv.dev/vulnerability/RUSTSEC-2018-0018', aliases: ['CVE-2018-25023', 'GHSA-55m5-whcv-c49c', 'GHSA-66p5-j55p-32r9'], title: 'Advisory RUSTSEC-2018-0018',
        informational: 'unsound', versions: ['0.6.10'],
      },
      {
        ...common, name: 'smallvec', id: 'RUSTSEC-2021-0003', ghsa: 'GHSA-43w2-9j62-hq99', url: 'https://github.com/advisories/GHSA-43w2-9j62-hq99', aliases: ['CVE-2021-25900', 'GHSA-43w2-9j62-hq99'], title: 'Advisory RUSTSEC-2021-0003',
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', versions: ['0.6.10', '1.6.0'],
      },
    ])
  })

  it('keeps a GHSA or MAL- record RustSec does not publish, or for the versions it was not answered for', async () => {
    stubOsv({
      // GitHub's own, and a malicious crate's.
      'ghsa-only@1.0.0': ['GHSA-aaaa-aaaa-aaaa'],
      'typosquat@0.1.0': ['MAL-2026-0001'],
      // Named as an alias by the GHSA alone; the GHSA's range is wider.
      'smallvec@1.6.0': ['RUSTSEC-2021-0003', 'GHSA-43w2-9j62-hq99'],
      'smallvec@1.7.0': ['GHSA-43w2-9j62-hq99'],
      // A MAL- record that GitHub also publishes.
      'evil@1.0.0': ['MAL-2026-0002', 'GHSA-bbbb-bbbb-bbbb'],
      // Beside a withdrawn RUSTSEC record.
      'other@1.0.0': ['RUSTSEC-2026-0001', 'GHSA-cccc-cccc-cccc'],
    }, {
      'GHSA-aaaa-aaaa-aaaa': ghsa('GHSA-aaaa-aaaa-aaaa', { aliases: ['CVE-2026-0001'] }),
      'MAL-2026-0001': { id: 'MAL-2026-0001', summary: 'Malicious code in typosquat (crates.io)' },
      'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { aliases: ['CVE-2021-25900'] }),
      'GHSA-43w2-9j62-hq99': ghsa('GHSA-43w2-9j62-hq99', { aliases: ['CVE-2021-25900', 'RUSTSEC-2021-0003'] }),
      'MAL-2026-0002': { id: 'MAL-2026-0002', aliases: ['GHSA-bbbb-bbbb-bbbb'] },
      'GHSA-bbbb-bbbb-bbbb': ghsa('GHSA-bbbb-bbbb-bbbb', { aliases: [] }),
      'RUSTSEC-2026-0001': rustsec('RUSTSEC-2026-0001', { aliases: ['GHSA-cccc-cccc-cccc'], withdrawn: '2026-01-01T00:00:00Z' }),
      'GHSA-cccc-cccc-cccc': ghsa('GHSA-cccc-cccc-cccc', { aliases: ['RUSTSEC-2026-0001'] }),
    })
    const found = await cargo(['ghsa-only@1.0.0', 'typosquat@0.1.0', 'smallvec@1.6.0', 'smallvec@1.7.0', 'evil@1.0.0', 'other@1.0.0'].map((spec) => {
      const [name, version] = spec.split('@')
      return { name, version }
    }))
    // The RUSTSEC row has the GHSA that names it among its aliases.
    assert.deepEqual(found.map(({ name, id, ghsa: of, aliases, versions }) => [name, id, of, aliases, versions]), [
      ['evil', 'GHSA-bbbb-bbbb-bbbb', 'GHSA-bbbb-bbbb-bbbb', ['MAL-2026-0002'], ['1.0.0']],
      ['ghsa-only', 'GHSA-aaaa-aaaa-aaaa', 'GHSA-aaaa-aaaa-aaaa', ['CVE-2026-0001'], ['1.0.0']],
      ['other', 'GHSA-cccc-cccc-cccc', 'GHSA-cccc-cccc-cccc', ['RUSTSEC-2026-0001'], ['1.0.0']],
      ['smallvec', 'GHSA-43w2-9j62-hq99', 'GHSA-43w2-9j62-hq99', ['CVE-2021-25900', 'RUSTSEC-2021-0003'], ['1.7.0']],
      ['smallvec', 'RUSTSEC-2021-0003', 'GHSA-43w2-9j62-hq99', ['CVE-2021-25900', 'GHSA-43w2-9j62-hq99'], ['1.6.0']],
      ['typosquat', 'MAL-2026-0001', undefined, [], ['0.1.0']],
    ])
    // GitHub's page for a row with a GHSA; osv.dev's for one without, built
    // from the id of the record OSV answered with, which it has a page for.
    assert.deepEqual(found.map(({ url }) => url), [
      'https://github.com/advisories/GHSA-bbbb-bbbb-bbbb',
      'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa',
      'https://github.com/advisories/GHSA-cccc-cccc-cccc',
      'https://github.com/advisories/GHSA-43w2-9j62-hq99',
      'https://github.com/advisories/GHSA-43w2-9j62-hq99',
      'https://osv.dev/vulnerability/MAL-2026-0001',
    ])
  })

  it("with details, takes each record's text from the record it already fetches, and reads none without", async () => {
    const hits = { 'smallvec@1.6.0': ['RUSTSEC-2021-0003'], 'smallvec@0.6.10': ['RUSTSEC-2018-0018'] }
    const records = {
      'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { details: 'Affected versions of this crate did not check bounds.' }),
      'RUSTSEC-2018-0018': rustsec('RUSTSEC-2018-0018', { aliases: [] }),
    }
    const pairs = [{ name: 'smallvec', version: '1.6.0' }, { name: 'smallvec', version: '0.6.10' }]
    let calls = stubOsv(hits, records)
    const found = await cargo(pairs, { details: true })
    assert.deepEqual(found.map(({ id, details }) => [id, details]), [['RUSTSEC-2018-0018', undefined], ['RUSTSEC-2021-0003', 'Affected versions of this crate did not check bounds.']])
    assert.equal(calls.length, 3)
    const malformed = { ...records, 'RUSTSEC-2018-0018': rustsec('RUSTSEC-2018-0018', { aliases: [], details: 'a\uD800b' }) }
    calls = stubOsv(hits, malformed)
    assert.ok((await cargo(pairs)).every((entry) => !Object.hasOwn(entry, 'details')))
    assert.equal(calls.length, 3)
    stubOsv(hits, malformed)
    await assert.rejects(cargo(pairs, { details: true }), /advisories: malformed details in RUSTSEC-2018-0018/u)
  })

  it('reports a version once for records linked directly or through another, equal ranks by id', async () => {
    stubOsv({
      // Two GHSAs naming each other.
      'dup@1.0.0': ['GHSA-eeee-eeee-eeee', 'GHSA-dddd-dddd-dddd'],
      // RustSec and a MAL- record both name a GHSA answered for 2.0.0 alone.
      'chain@1.0.0': ['RUSTSEC-2026-0002', 'MAL-2026-0003'],
      'chain@2.0.0': ['GHSA-ffff-ffff-ffff'],
    }, {
      'GHSA-dddd-dddd-dddd': ghsa('GHSA-dddd-dddd-dddd', { aliases: ['GHSA-eeee-eeee-eeee'] }),
      'GHSA-eeee-eeee-eeee': ghsa('GHSA-eeee-eeee-eeee', { aliases: ['GHSA-dddd-dddd-dddd'] }),
      'RUSTSEC-2026-0002': rustsec('RUSTSEC-2026-0002', { aliases: ['GHSA-ffff-ffff-ffff'] }),
      'MAL-2026-0003': { id: 'MAL-2026-0003', aliases: ['GHSA-ffff-ffff-ffff'] },
      'GHSA-ffff-ffff-ffff': ghsa('GHSA-ffff-ffff-ffff', { aliases: [] }),
    })
    const found = await cargo([{ name: 'dup', version: '1.0.0' }, { name: 'chain', version: '1.0.0' }, { name: 'chain', version: '2.0.0' }])
    assert.deepEqual(found.map(({ name, id, aliases, versions }) => [name, id, aliases, versions]), [
      ['chain', 'GHSA-ffff-ffff-ffff', ['RUSTSEC-2026-0002', 'MAL-2026-0003'], ['2.0.0']],
      ['chain', 'RUSTSEC-2026-0002', ['GHSA-ffff-ffff-ffff', 'MAL-2026-0003'], ['1.0.0']],
      ['dup', 'GHSA-dddd-dddd-dddd', ['GHSA-eeee-eeee-eeee'], ['1.0.0']],
    ])
  })

  it('keeps only aliases, kinds and metrics in their documented shape, and refuses a title that is not well-formed', async () => {
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, {
      'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', {
        aliases: ['CVE-2021-25900', 'not an id', 'X'.repeat(200)],
        severity: [{ type: 'CVSS_V3', score: 'high' }],
        database_specific: { severity: 'MEDIUM', cwe_ids: ['CWE-787', 'CWE-x'] },
        affected: [{ package: { name: 'smallvec', ecosystem: 'crates.io' }, database_specific: { informational: 'deprecated' } }],
      }),
    })
    const [found] = await cargo([{ name: 'smallvec', version: '1.6.0' }])
    assert.deepEqual({ aliases: found.aliases, severity: found.severity, cvssVector: found.cvssVector, cwe: found.cwe, informational: found.informational }, {
      aliases: ['CVE-2021-25900'], severity: 'moderate', cvssVector: undefined, cwe: ['CWE-787'], informational: undefined,
    })
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { summary: 'a\uDC00' }) })
    await assert.rejects(cargo([{ name: 'smallvec', version: '1.6.0' }]), /advisories: malformed OSV record RUSTSEC-2021-0003/u)
  })

  it('leaves out a withdrawn record', async () => {
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { withdrawn: '2026-01-01T00:00:00Z' }) })
    assert.deepEqual(await cargo([{ name: 'smallvec', version: '1.6.0' }]), [])
  })

  it('asks for 1000 versions at a time', async () => {
    const calls = stubOsv({}, {})
    const packages = Array.from({ length: 1001 }, (_, i) => ({ name: `crate${String(i).padStart(4, '0')}`, version: '1.0.0' }))
    assert.deepEqual(await cargo(packages), [])
    assert.deepEqual(calls.map((call) => call.body.queries.length), [1000, 1])
  })

  it('refuses a malformed crate name or version, before any request', async () => {
    const calls = stubOsv({}, {})
    for (const name of ['', '1abc', '../x', 'a/b', 'a b', 'x'.repeat(65), ['smallvec'], undefined]) {
      await assert.rejects(cargo([{ name, version: '1.0.0' }]), /advisories: package\.name must be a crate name/u, String(name))
    }
    for (const version of ['1.0', '^1.0.0', 'v1.0.0', '01.0.0', '1.0.0+', '1.0.0 ', '*', undefined]) {
      await assert.rejects(cargo([{ name: 'smallvec', version }]), /advisories: package\.versions must be a semver version/u, String(version))
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
      await assert.rejects(cargo(one), error, JSON.stringify(results))
    }
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0004') })
    await assert.rejects(cargo(one), /advisories: OSV answered for "RUSTSEC-2021-0004", not RUSTSEC-2021-0003/u)
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003', { aliases: 'CVE-2021-25900' }) })
    await assert.rejects(cargo(one), /advisories: malformed OSV record RUSTSEC-2021-0003/u)
    stubOsv({ 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] }, {})
    await assert.rejects(cargo(one), (err) => err instanceof HttpError && err.status === 404)
  })
})

describe('composer', () => {
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
    const found = await composer([
      { name: 'drupal/core', version: '9.5.0' },
      { name: 'drupal/other', version: '1.0.0' },
      { name: 'symfony/http-kernel', version: 'v7.4.5' },
    ])
    assert.deepEqual(found.map(({ name, id }) => `${name} ${id}`), [
      'drupal/core DRUPAL-CORE-2023-001',
      'drupal/core GHSA-2qph-q8xw-gv7q',
      'drupal/other DRUPAL-CORE-2025-003',
      'symfony/http-kernel GHSA-6439-2f28-8p8q',
    ])
    assert.deepEqual(found[0], { ecosystem: 'composer', name: 'drupal/core', source: 'osv', id: 'DRUPAL-CORE-2023-001', url: 'https://osv.dev/vulnerability/DRUPAL-CORE-2023-001', aliases: [], cwe: [], versions: ['9.5.0'] })
    assert.deepEqual(found[1], {
      ecosystem: 'composer',
      name: 'drupal/core',
      source: 'osv',
      id: 'GHSA-2qph-q8xw-gv7q',
      ghsa: 'GHSA-2qph-q8xw-gv7q',
      url: 'https://github.com/advisories/GHSA-2qph-q8xw-gv7q',
      aliases: ['CVE-2025-31674', 'DRUPAL-CORE-2025-003'],
      title: 'Advisory GHSA-2qph-q8xw-gv7q',
      severity: 'moderate',
      cvssVector: 'CVSS:4.0/AV:N/AC:H/AT:N/PR:H/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:U',
      cwe: ['CWE-913'],
      versions: ['9.5.0'],
    })
    assert.equal(found[2].ghsa, 'GHSA-2qph-q8xw-gv7q')
    assert.equal(found[3].severity, 'high')
  })

  it('keeps the versions of an aliased record that its GHSA was not answered for, and all of them beside a withdrawn GHSA', async () => {
    stubOsv({
      'acme/app@1.0.0': ['CVE-2026-0001'],
      'acme/app@2.0.0': ['CVE-2026-0001', 'GHSA-aaaa-aaaa-aaaa'],
      'acme/lib@1.0.0': ['CVE-2026-0002', 'GHSA-bbbb-bbbb-bbbb'],
    }, {
      'CVE-2026-0001': { id: 'CVE-2026-0001', aliases: ['GHSA-aaaa-aaaa-aaaa'] },
      'GHSA-aaaa-aaaa-aaaa': ghsa('GHSA-aaaa-aaaa-aaaa', { aliases: ['CVE-2026-0001'] }),
      'CVE-2026-0002': { id: 'CVE-2026-0002', aliases: ['GHSA-bbbb-bbbb-bbbb'] },
      'GHSA-bbbb-bbbb-bbbb': ghsa('GHSA-bbbb-bbbb-bbbb', { aliases: ['CVE-2026-0002'], withdrawn: '2026-01-01T00:00:00Z' }),
    })
    const found = await composer([{ name: 'acme/app', version: '1.0.0' }, { name: 'acme/app', version: '2.0.0' }, { name: 'acme/lib', version: '1.0.0' }])
    assert.deepEqual(found.map(({ name, id, versions }) => [name, id, versions]), [
      ['acme/app', 'CVE-2026-0001', ['1.0.0']],
      ['acme/app', 'GHSA-aaaa-aaaa-aaaa', ['2.0.0']],
      ['acme/lib', 'CVE-2026-0002', ['1.0.0']],
    ])
  })

  it('reports a version once for two records other than a GHSA that name each other', async () => {
    stubOsv({ 'drupal/core@9.5.0': ['PKSA-n4ry-zn1q-xn5z', 'DRUPAL-CORE-2026-001'] }, {
      'PKSA-n4ry-zn1q-xn5z': { id: 'PKSA-n4ry-zn1q-xn5z', aliases: ['DRUPAL-CORE-2026-001'] },
      'DRUPAL-CORE-2026-001': { id: 'DRUPAL-CORE-2026-001' },
    })
    const found = await composer([{ name: 'drupal/core', version: '9.5.0' }])
    assert.deepEqual(found.map(({ id, aliases, versions }) => [id, aliases, versions]), [['DRUPAL-CORE-2026-001', ['PKSA-n4ry-zn1q-xn5z'], ['9.5.0']]])
  })

  it('takes Composer release versions, and refuses dev versions and malformed names, before any request', async () => {
    const calls = stubOsv({}, {})
    for (const version of ['1.2.3', 'v1.2.3', '1.2.3.4', '2.0.0-beta1', '2.0.0-RC2', '1.0.0-p1', '1.0']) {
      await composer([{ name: 'acme/app', version }])
    }
    assert.equal(calls.length, 7)
    for (const version of ['dev-main', '2.x-dev', '1.0.0-dev', '^1.0', '1.0.0 ', '', undefined]) {
      await assert.rejects(composer([{ name: 'acme/app', version }]), /advisories: package\.versions must be a Composer release version/u, String(version))
    }
    for (const name of ['acme', 'Acme/App', 'acme/', '/app', 'acme/app/x', '../app', 'acme/ap p', undefined]) {
      await assert.rejects(composer([{ name, version: '1.0.0' }]), /advisories: package\.name must be a Composer package name/u, String(name))
    }
    assert.equal(calls.length, 7)
  })
})

describe('cargo and composer, with a GitHub client', () => {
  const github = createClient({ token: 'test-token' })
  const CRATES = 'https://crates.io/api/v1/crates?'
  const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
  const repoAdvisory = (id, vulnerabilities, overrides = {}) => ({ ghsa_id: id, state: 'published', summary: `Advisory ${id}`, severity: 'medium', vulnerabilities, ...overrides })
  const vuln = (ecosystem, name, range) => ({ package: { ecosystem, name }, vulnerable_version_range: range })

  // OSV, crates.io, Packagist and GitHub, each answering from what is
  // given; `calls` is every request, with its headers.
  function stubAll({ hits = {}, records = {}, crates = {}, packagist = {}, listings = {} }) {
    const calls = []
    globalThis.fetch = (url, init = {}) => {
      url = String(url)
      calls.push({ url, headers: init.headers ?? {} })
      if (url === BATCH) {
        const { queries } = JSON.parse(init.body)
        return Promise.resolve(Response.json({ results: queries.map(({ package: { name }, version }) => ({ vulns: (hits[`${name}@${version}`] ?? []).map((id) => ({ id })) })) }))
      }
      if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
      if (url.startsWith(CRATES)) {
        const ids = new URL(url).searchParams.getAll('ids[]')
        return Promise.resolve(crates instanceof Response ? crates.clone() : Response.json({ crates: ids.filter((id) => Object.hasOwn(crates, id)).map((id) => ({ id, repository: crates[id] })) }))
      }
      const p2 = /^https:\/\/repo\.packagist\.org\/p2\/(.+)\.json$/u.exec(url)
      if (p2) {
        const name = p2[1]
        return Promise.resolve(Object.hasOwn(packagist, name) ? Response.json({ packages: { [name]: [{ version: '9.9.9', source: { url: packagist[name] } }] } }) : Response.json({}, { status: 404 }))
      }
      const listed = Object.entries(listings).find(([repo]) => url === listing(repo))
      if (listed) return Promise.resolve(Response.json(listed[1]))
      return Promise.reject(new Error(`unexpected request: ${url}`))
    }
    return calls
  }

  it("adds what a crate's repository publishes that RustSec does not have, once per repo", async () => {
    const calls = stubAll({
      hits: { 'smallvec@1.6.0': ['RUSTSEC-2021-0003'] },
      records: { 'RUSTSEC-2021-0003': rustsec('RUSTSEC-2021-0003') },
      crates: { smallvec: 'https://github.com/servo/rust-smallvec', 'local-only': null },
      listings: {
        'servo/rust-smallvec': [
          // Already answered by OSV, through the RustSec record's alias.
          repoAdvisory('GHSA-43w2-9j62-hq99', [vuln('rust', 'smallvec', '< 1.6.1')]),
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('rust', 'smallvec', '>= 1.0.0, < 1.7.0'), vuln('rust', 'other-crate', '< 9.0.0'), vuln('npm', 'smallvec', '< 9.0.0')]),
        ],
      },
    })
    const found = await cargo([{ name: 'smallvec', version: '1.6.0' }, { name: 'local-only', version: '0.1.0' }, { name: 'not-on-crates-io', version: '1.0.0' }], { github, repoAdvisories: true })
    assert.deepEqual(found.map(({ source, id, url, range, versions }) => [source, id, url, range, versions]), [
      ['osv', 'RUSTSEC-2021-0003', 'https://github.com/advisories/GHSA-43w2-9j62-hq99', undefined, ['1.6.0']],
      ['repository', 'GHSA-bbbb-bbbb-bbbb', 'https://github.com/servo/rust-smallvec/security/advisories/GHSA-bbbb-bbbb-bbbb', '>= 1.0.0, < 1.7.0', ['1.6.0']],
    ])
    const toCrates = calls.filter(({ url }) => url.startsWith(CRATES))
    assert.equal(toCrates.length, 1)
    assert.deepEqual(new URL(toCrates[0].url).searchParams.getAll('ids[]'), ['local-only', 'not-on-crates-io', 'smallvec'])
    assert.match(toCrates[0].headers['User-Agent'], /^@preventive\/upstream /u)
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('https://api.github.com/')).map(({ url }) => url), [listing('servo/rust-smallvec')])
  })

  it('asks a repository given without looking it up, and none without repoAdvisories', async () => {
    const answers = { crates: { smallvec: 'https://github.com/servo/rust-smallvec' }, listings: { 'acme/fork': [repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('rust', 'smallvec', '< 9.0.0')])] } }
    let calls = stubAll(answers)
    const found = await cargo([{ name: 'smallvec', version: '1.6.0', github: 'acme/fork' }], { github, repoAdvisories: true })
    assert.deepEqual(found.map(({ id }) => id), ['GHSA-bbbb-bbbb-bbbb'])
    assert.deepEqual(calls.filter(({ url }) => url !== BATCH).map(({ url }) => url), [listing('acme/fork')])
    calls = stubAll(answers)
    assert.deepEqual(await cargo([{ name: 'smallvec', version: '1.6.0', github: 'acme/fork' }], { github }), [])
    assert.deepEqual(calls.map(({ url }) => url), [BATCH])
  })

  it('reads a Composer version past its `v`, and takes one semver cannot read as every version', async () => {
    const calls = stubAll({
      hits: { 'monolog/monolog@v1.2.3': ['GHSA-f57v-q966-7fh6'] },
      records: { 'GHSA-f57v-q966-7fh6': { id: 'GHSA-f57v-q966-7fh6', aliases: [], summary: 'Header injection' } },
      packagist: { 'monolog/monolog': 'https://github.com/Seldaek/monolog.git' },
      listings: {
        'Seldaek/monolog': [
          repoAdvisory('GHSA-f57v-q966-7fh6', [vuln('composer', 'monolog/monolog', '< 9.0.0')]),
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('composer', 'monolog/monolog', '>= 1.0.0, < 1.3.0')]),
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('composer', 'monolog/monolog', '>= 2.0.0')]),
        ],
      },
    })
    const found = await composer([{ name: 'monolog/monolog', version: 'v1.2.3' }, { name: 'monolog/monolog', version: '1.2.3.4' }, { name: 'acme/private', version: '1.0.0' }], { github, repoAdvisories: true })
    // OSV answered for v1.2.3 alone; the repository's range covers 1.2.3.4 too.
    assert.deepEqual(found.map(({ source, id, severity, versions }) => [source, id, severity, versions]), [
      ['osv', 'GHSA-f57v-q966-7fh6', undefined, ['v1.2.3']],
      ['repository', 'GHSA-f57v-q966-7fh6', 'moderate', ['1.2.3.4']],
      ['repository', 'GHSA-bbbb-bbbb-bbbb', 'moderate', ['1.2.3.4', 'v1.2.3']],
      ['repository', 'GHSA-cccc-cccc-cccc', 'moderate', ['1.2.3.4']],
    ])
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('https://repo.packagist.org/')).map(({ url }) => url).toSorted(), [
      'https://repo.packagist.org/p2/acme/private.json',
      'https://repo.packagist.org/p2/monolog/monolog.json',
    ])
  })

  it('throws when a repository cannot be looked up, or an answer is about something not asked', async () => {
    const one = [{ name: 'smallvec', version: '1.6.0' }]
    const options = { github, repoAdvisories: true }
    stubAll({ crates: Response.json({ errors: [] }, { status: 500 }) })
    await assert.rejects(cargo(one, options), { name: 'HttpError', status: 500 })
    stubAll({ crates: { smallvec: 'https://github.com/servo/rust-smallvec' } })
    const stubbed = globalThis.fetch
    globalThis.fetch = (url, init) => (String(url).startsWith(CRATES) ? Promise.resolve(Response.json({ crates: [{ id: 'serde', repository: null }] })) : stubbed(url, init))
    await assert.rejects(cargo(one, options), /advisories: crates\.io answered for "serde", which was not asked/u)
    stubAll({})
    globalThis.fetch = (url) => Promise.resolve(String(url) === BATCH ? Response.json({ results: [{}] }) : Response.json({ packages: {} }))
    await assert.rejects(composer([{ name: 'acme/app', version: '1.0.0' }], options), /advisories: Packagist answered without acme\/app/u)
  })

  describe('through the cache', () => {
    let dir
    after(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it("keeps a crate's repo for the next run, and not one dated in the future", async () => {
      dir = await mkdtemp(join(tmpdir(), 'upstream-osv-cache-'))
      setCacheDir(dir)
      const answers = { crates: { smallvec: 'https://github.com/servo/rust-smallvec' }, listings: { 'servo/rust-smallvec': [] } }
      stubAll(answers)
      await cargo([{ name: 'smallvec', version: '1.6.0' }], { github, repoAdvisories: true })
      const calls = stubAll({ ...answers, crates: Response.json({}, { status: 500 }) })
      await cargo([{ name: 'smallvec', version: '1.6.0' }], { github, repoAdvisories: true })
      assert.deepEqual(calls.filter(({ url }) => url.startsWith(CRATES)), [])
      assert.equal(calls.filter(({ url }) => url === listing('servo/rust-smallvec')).length, 1)
      await writeFile(join(dir, 'cargo', 'repos', 'smallvec.json'), JSON.stringify({ at: Date.now() + 60_000, name: 'smallvec', github: 'evil/fork' }))
      const again = stubAll(answers)
      await cargo([{ name: 'smallvec', version: '1.6.0' }], { github, repoAdvisories: true })
      assert.equal(again.filter(({ url }) => url.startsWith(CRATES)).length, 1)
      assert.deepEqual(again.filter(({ url }) => url.startsWith('https://api.github.com/')).map(({ url }) => url), [listing('servo/rust-smallvec')])
    })
  })
})
