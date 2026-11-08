import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const swift = (name, versions, rest = {}) => ({ ecosystem: 'swift', name, versions, ...rest })

// OSV and GitHub, answering from what is given: `hits` is `name@version`
// -> ids, `records` id -> record, `listings` repo -> its listing. `calls`
// is every request, with its parsed body.
function stubAll({ hits = {}, records = {}, listings = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body })
    if (url === BATCH) {
      return Promise.resolve(Response.json({ results: body.queries.map(({ package: { name }, version }) => ({ vulns: (hits[`${name}@${version}`] ?? []).map((id) => ({ id })) })) }))
    }
    if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
    const listed = Object.entries(listings).find(([repo]) => url === listing(repo))
    if (listed) return Promise.resolve(Response.json(listed[1]))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// As OSV has GitHub's record of vapor's GHSA-gcj9-jj38-hwmc.
const ghsa = (id, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: ['CVE-2021-21328'],
  database_specific: { severity: 'MODERATE', github_reviewed: true, cwe_ids: ['CWE-400'] },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
  affected: [{ package: { name: 'github.com/vapor/vapor', ecosystem: 'SwiftURL', purl: 'pkg:swift/github.com/vapor/vapor' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.40.1' }] }] }],
  ...overrides,
})
const repoAdvisory = (id, vulnerabilities) => ({ ghsa_id: id, state: 'published', summary: `Advisory ${id}`, severity: 'high', vulnerabilities })
const vuln = (name, range, ecosystem = 'swift') => ({ package: { ecosystem, name }, vulnerable_version_range: range })

describe('swift', () => {
  it("asks OSV's SwiftURL of each version, by the repository as it is spelled, and answers its records", async () => {
    const calls = stubAll({
      hits: { 'github.com/vapor/vapor@4.0.0': ['GHSA-gcj9-jj38-hwmc'] },
      records: { 'GHSA-gcj9-jj38-hwmc': ghsa('GHSA-gcj9-jj38-hwmc') },
    })
    const found = await advisories([swift('github.com/vapor/vapor', ['4.40.1', '4.0.0']), swift('github.com/weichsel/ZIPFoundation', ['0.9.19'])])
    assert.deepEqual(calls[0].body, {
      queries: [
        { package: { name: 'github.com/vapor/vapor', ecosystem: 'SwiftURL' }, version: '4.0.0' },
        { package: { name: 'github.com/vapor/vapor', ecosystem: 'SwiftURL' }, version: '4.40.1' },
        { package: { name: 'github.com/weichsel/ZIPFoundation', ecosystem: 'SwiftURL' }, version: '0.9.19' },
      ],
    })
    assert.deepEqual(calls.slice(1).map(({ url }) => url), [`${VULN}GHSA-gcj9-jj38-hwmc`])
    assert.deepEqual(found, [{
      ecosystem: 'swift',
      name: 'github.com/vapor/vapor',
      source: 'osv',
      id: 'GHSA-gcj9-jj38-hwmc',
      ghsa: 'GHSA-gcj9-jj38-hwmc',
      url: 'https://github.com/advisories/GHSA-gcj9-jj38-hwmc',
      aliases: ['CVE-2021-21328'],
      title: 'Advisory GHSA-gcj9-jj38-hwmc',
      severity: 'moderate',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L',
      cwe: ['CWE-400'],
      versions: ['4.0.0'],
    }])
  })

  it("refuses a name OSV doesn't spell so, and a pin's branch or revision for a version, before any request", async () => {
    const calls = stubAll()
    for (const name of ['https://github.com/vapor/vapor', 'github.com/vapor/vapor.git', 'github.com/vapor/vapor/', 'GitHub.com/vapor/vapor', 'github.com/../vapor', 'git@github.com:vapor/vapor', 'vapor', 'vapor.vapor', '', undefined]) {
      await assert.rejects(advisories([swift(name, ['4.0.0'])]), /advisories: package\.name must be a Swift package's repository as OSV names it/u, String(name))
    }
    for (const version of ['main', '0a5bc04e1b7a9f8c6d3e2a1b0c9d8e7f6a5b4c3d', 'v4.0.0', '4.0', '04.0.0', '4.0.0 ', '', undefined]) {
      await assert.rejects(advisories([swift('github.com/vapor/vapor', [version])]), /advisories: package\.versions must be a version as SwiftPM writes one/u, String(version))
    }
    // An identifier may be empty, as SwiftPM reads a tag; a host other
    // than github.com, and a repository in a group, are names too.
    for (const [name, version] of [['github.com/weichsel/ZIPFoundation', '1.0.0-'], ['gitlab.com/group/sub/project', '1.0.0-beta..1+'], ['github.com/apple/swift-nio', '2.65.0']]) {
      assert.deepEqual(await advisories([swift(name, [version])]), [], name)
    }
    assert.equal(calls.length, 3)
  })
})

describe('swift, with a GitHub client', () => {
  const options = { github, repoAdvisories: true }

  it("asks a package on github.com's own repository, with no request to find it, for its swift entries naming it, ranges by semver", async () => {
    const calls = stubAll({
      listings: {
        'vapor/vapor': [
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('github.com/vapor/vapor', '>= 4.0.0, < 4.40.1')]),
          // Another package of the repository, or another ecosystem's, is
          // not this one's.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('github.com/vapor/other', '< 9.0.0'), vuln('github.com/vapor/vapor', '< 9.0.0', 'npm')]),
          // A version semver can't read is covered by every range.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('github.com/vapor/vapor', '< 1.0.0')]),
        ],
      },
    })
    const found = await advisories([swift('github.com/vapor/vapor', ['4.0.0', '4.40.1', '4.41.0-']), swift('gitlab.com/group/project', ['1.0.0'])], options)
    assert.deepEqual(found.map(({ source, id, url, range, versions }) => [source, id, url, range, versions]), [
      ['repository', 'GHSA-aaaa-aaaa-aaaa', 'https://github.com/vapor/vapor/security/advisories/GHSA-aaaa-aaaa-aaaa', '>= 4.0.0, < 4.40.1', ['4.0.0', '4.41.0-']],
      ['repository', 'GHSA-cccc-cccc-cccc', 'https://github.com/vapor/vapor/security/advisories/GHSA-cccc-cccc-cccc', '< 1.0.0', ['4.41.0-']],
    ])
    assert.deepEqual(calls.map(({ url }) => url), [BATCH, listing('vapor/vapor')])
  })

  it('asks the repository given for a package instead', async () => {
    const calls = stubAll({ listings: { 'acme/fork': [repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('gitlab.com/acme/kit', '< 2.0.0')])] } })
    const found = await advisories([swift('gitlab.com/acme/kit', ['1.0.0'], { github: 'acme/fork' })], options)
    assert.deepEqual(found.map(({ id, versions }) => [id, versions]), [['GHSA-aaaa-aaaa-aaaa', ['1.0.0']]])
    assert.deepEqual(calls.map(({ url }) => url), [BATCH, listing('acme/fork')])
  })
})
