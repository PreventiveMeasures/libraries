import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const SHA = '0e58ed8671d6b60d0890c21b07f8835ace038e67'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const repo = (name, versions) => ({ ecosystem: 'github', name, versions })

// OSV, answering a package-only query with `records`' ids for that name, and
// GitHub, each repo's `listings`. `calls` is every request, bodies parsed.
function stubAll({ records = {}, listings = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body })
    if (url === BATCH) {
      const ids = (name) => Object.values(records).filter((record) => record.affected.some((entry) => entry.package.name === name)).map(({ id }) => ({ id }))
      return Promise.resolve(Response.json({ results: body.queries.map(({ package: { name } }) => ({ vulns: ids(name) })) }))
    }
    if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
    const listed = Object.entries(listings).find(([name]) => url === listing(name))
    return listed ? Promise.resolve(Response.json(listed[1])) : Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// As OSV has tj-actions/changed-files' GHSA-mrrh-fwg8-r2c3: fixed in 46.0.1.
const record = (id, name, ranges, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: [],
  database_specific: { severity: 'HIGH', cwe_ids: ['CWE-506'] },
  affected: [{ package: { ecosystem: 'GitHub Actions', name }, ranges }],
  ...overrides,
})
const fixedIn = (fixed, introduced = '0') => [{ type: 'ECOSYSTEM', events: [{ introduced }, { fixed }] }]

describe('github, from OSV of GitHub Actions', () => {
  it('asks OSV of each repository as an Action, with no version, and matches its tags as semver, `v` or not', async () => {
    const calls = stubAll({ records: { 'GHSA-mrrh-fwg8-r2c3': record('GHSA-mrrh-fwg8-r2c3', 'tj-actions/changed-files', fixedIn('46.0.1')) }, listings: { 'tj-actions/changed-files': [], 'actions/checkout': [] } })
    const found = await advisories([repo('tj-actions/changed-files', ['v35.7.6', '45.0.0', '46.0.1', 'v47.0.0']), repo('actions/checkout', ['v4'])], { github })
    assert.deepEqual(calls.find(({ url }) => url === BATCH).body.queries, [
      { package: { name: 'actions/checkout', ecosystem: 'GitHub Actions' } },
      { package: { name: 'tj-actions/changed-files', ecosystem: 'GitHub Actions' } },
    ])
    assert.deepEqual(found.map(({ name, source, id, url, malware, versions }) => [name, source, id, url, malware, versions]), [
      ['tj-actions/changed-files', 'osv', 'GHSA-mrrh-fwg8-r2c3', 'https://github.com/advisories/GHSA-mrrh-fwg8-r2c3', true, ['45.0.0', 'v35.7.6']],
    ])
  })

  it('takes a moving tag as its whole line, a commit as any release, and a branch or 0.0.0 as the newest', async () => {
    stubAll({
      records: {
        'GHSA-aaaa-aaaa-aaaa': record('GHSA-aaaa-aaaa-aaaa', 'acme/action', fixedIn('4.2.1', '4.2.0')),
        // Every release, none fixed.
        'GHSA-bbbb-bbbb-bbbb': record('GHSA-bbbb-bbbb-bbbb', 'acme/action', [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }]),
        'GHSA-cccc-cccc-cccc': record('GHSA-cccc-cccc-cccc', 'acme/action', [{ type: 'ECOSYSTEM', events: [{ introduced: '1.0.0' }, { last_affected: '1.2' }] }]),
        // Listed versions alone, OSV's other shape.
        'GHSA-dddd-dddd-dddd': record('GHSA-dddd-dddd-dddd', 'acme/action', [], { affected: [{ package: { ecosystem: 'GitHub Actions', name: 'acme/action' }, versions: ['v3.0.0'] }] }),
      },
      listings: { 'acme/action': [] },
    })
    const found = await advisories([repo('acme/action', ['v4', 'v4.1', 'v4.2', 'v1', '1.2.0', '1.2.1', 'v3.0.0', SHA, 'main', '0.0.0'])], { github })
    assert.deepEqual(Object.fromEntries(found.map(({ id, versions }) => [id, versions])), {
      'GHSA-aaaa-aaaa-aaaa': [SHA, 'v4', 'v4.2'],
      'GHSA-bbbb-bbbb-bbbb': ['0.0.0', SHA, '1.2.0', '1.2.1', 'main', 'v1', 'v3.0.0', 'v4', 'v4.1', 'v4.2'],
      // OSV's `1.2` is 1.2.0.
      'GHSA-cccc-cccc-cccc': [SHA, '1.2.0', 'v1'],
      'GHSA-dddd-dddd-dddd': [SHA, 'v3.0.0'],
    })
  })

  it('takes a moving tag as its line against listed versions too, and a listed version as OSV writes it', async () => {
    const listed = (id, versions, ranges = []) => record(id, 'acme/action', ranges, { affected: [{ package: { ecosystem: 'GitHub Actions', name: 'acme/action' }, versions, ranges }] })
    stubAll({
      records: {
        'GHSA-aaaa-aaaa-aaaa': listed('GHSA-aaaa-aaaa-aaaa', ['3.0.0']),
        // Listed beside a range v5's line misses.
        'GHSA-bbbb-bbbb-bbbb': listed('GHSA-bbbb-bbbb-bbbb', ['5.1.0'], fixedIn('2.0.0')),
        // OSV's `1.2` is 1.2.0.
        'GHSA-cccc-cccc-cccc': listed('GHSA-cccc-cccc-cccc', ['v1.2']),
      },
      listings: { 'acme/action': [] },
    })
    const found = await advisories([repo('acme/action', ['v1.2.0', 'v3', 'v3.0', 'v3.0.0', 'v3.1.0', 'v4', 'v5'])], { github })
    assert.deepEqual(found.map(({ id, versions }) => [id, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', ['v3', 'v3.0', 'v3.0.0']],
      ['GHSA-bbbb-bbbb-bbbb', ['v1.2.0', 'v5']],
      ['GHSA-cccc-cccc-cccc', ['v1.2.0']],
    ])
  })

  it("is one row with the repository's own advisory of the same GHSA, and leaves out a withdrawn record", async () => {
    const calls = stubAll({
      records: {
        'GHSA-mrrh-fwg8-r2c3': record('GHSA-mrrh-fwg8-r2c3', 'tj-actions/changed-files', fixedIn('46.0.1')),
        'GHSA-zzzz-zzzz-zzzz': record('GHSA-zzzz-zzzz-zzzz', 'tj-actions/changed-files', fixedIn('99.0.0'), { withdrawn: '2025-04-01T00:00:00Z' }),
      },
      listings: {
        'tj-actions/changed-files': [{ ghsa_id: 'GHSA-mrrh-fwg8-r2c3', state: 'published', summary: 'From the repository', severity: 'critical', vulnerabilities: [{ package: { ecosystem: 'actions', name: 'tj-actions/changed-files' }, vulnerable_version_range: '< 46.0.1' }] }],
      },
    })
    const found = await advisories([repo('tj-actions/changed-files', ['v45.0.0', 'main'])], { github })
    assert.deepEqual(found.map(({ source, id, title, severity, range, versions }) => [source, id, title, severity, range, versions]), [
      // The repository's range takes the branch as every version, as it always has.
      ['osv', 'GHSA-mrrh-fwg8-r2c3', 'Advisory GHSA-mrrh-fwg8-r2c3', 'critical', '< 46.0.1', ['main', 'v45.0.0']],
    ])
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(VULN)).map(({ url }) => url).toSorted(), [`${VULN}GHSA-mrrh-fwg8-r2c3`, `${VULN}GHSA-zzzz-zzzz-zzzz`])
  })

  it('asks OSV by the first spelling of a repository given in two cases, and throws on a malformed answer', async () => {
    const calls = stubAll({ listings: { 'Azure/setup-kubectl': [] } })
    await advisories([repo('Azure/setup-kubectl', ['v3']), repo('azure/Setup-Kubectl', ['v4'])], { github })
    assert.deepEqual(calls.find(({ url }) => url === BATCH).body.queries.map(({ package: { name } }) => name), ['Azure/setup-kubectl'])
    globalThis.fetch = (url) => Promise.resolve(String(url) === BATCH ? Response.json({ results: [{ vulns: [{ id: '../x' }] }] }) : Response.json([]))
    await assert.rejects(advisories([repo('acme/action', ['v1'])], { github }), /advisories: malformed OSV result for acme\/action/u)
  })
})

describe('github, internal', () => {
  it('asks a repository given `internal: true` of its own advisories alone, its name sent to no other source', async () => {
    const own = { ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'published', summary: 'From the repository', severity: 'high', vulnerabilities: [{ package: { ecosystem: 'actions', name: 'acme/secret' }, vulnerable_version_range: '< 2.0.0' }] }
    const calls = stubAll({ records: { 'GHSA-mrrh-fwg8-r2c3': record('GHSA-mrrh-fwg8-r2c3', 'acme/open', fixedIn('2.0.0')) }, listings: { 'acme/open': [], 'acme/secret': [own] } })
    const found = await advisories([repo('acme/open', ['v1.0.0']), { ...repo('acme/secret', ['v1.0.0']), internal: true }], { github })
    assert.deepEqual(calls.filter(({ url }) => url === BATCH).flatMap(({ body }) => body.queries.map(({ package: { name } }) => name)), ['acme/open'])
    assert.deepEqual(found.map(({ name, source, id, versions }) => [name, source, id, versions]), [
      ['acme/open', 'osv', 'GHSA-mrrh-fwg8-r2c3', ['v1.0.0']],
      ['acme/secret', 'repository', 'GHSA-aaaa-aaaa-aaaa', ['v1.0.0']],
    ])
    const alone = stubAll({ listings: { 'acme/secret': [] } })
    await advisories([{ ...repo('acme/secret', ['v1']), internal: true }], { github })
    assert.deepEqual(alone.map(({ url }) => url), [listing('acme/secret')], 'none asked of OSV')
  })

  it('takes a repository as internal where any spelling of it is, and refuses `internal` on another ecosystem', async () => {
    const calls = stubAll({ listings: { 'Acme/Secret': [], 'acme/other': [] } })
    await advisories([repo('Acme/Secret', ['v1']), { ...repo('acme/secret', ['v2']), internal: true }, { ...repo('acme/other', ['v1']), internal: false }], { github })
    assert.deepEqual(calls.filter(({ url }) => url === BATCH).flatMap(({ body }) => body.queries.map(({ package: { name } }) => name)), ['acme/other'])
    await assert.rejects(advisories([{ ecosystem: 'npm', name: 'left-pad', versions: ['1.3.0'], internal: true }]), /only a github package takes package\.internal/u)
    await assert.rejects(advisories([{ ...repo('acme/x', ['v1']), internal: 'yes' }], { github }), /package\.internal must be a boolean/u)
  })
})
