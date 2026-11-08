import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { mapStore } from './cache-store.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const GEMS = 'https://rubygems.org/api/v1/gems/'
const realFetch = globalThis.fetch

// rubygems.org is paced 100 ms a request, process-wide: on a clock of the
// tests' own, 100 ms a real one, carried from test to test so the pacer's
// state is never ahead of it.
let clock = Date.now()
let ticker
beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clock })
  syncBuiltinESMExports()
  ticker = setInterval(() => mock.timers.tick(100), 1)
})

afterEach(() => {
  clearInterval(ticker)
  clock = Date.now()
  mock.timers.reset()
  syncBuiltinESMExports()
  globalThis.fetch = realFetch
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const gem = (name, versions, rest = {}) => ({ ecosystem: 'gem', name, versions, ...rest })

// OSV, rubygems.org and GitHub, each answering from what is given: `hits`
// is `name@version` -> ids, `records` id -> record, `gems` name -> the
// gem's document (a Response as is), and `listings` repo -> its listing.
// `calls` is every request, with its parsed body and when it was made.
function stubAll({ hits = {}, records = {}, gems = {}, listings = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body, at: Date.now() })
    if (url === BATCH) {
      return Promise.resolve(Response.json({ results: body.queries.map(({ package: { name }, version }) => ({ vulns: (hits[`${name}@${version}`] ?? []).map((id) => ({ id })) })) }))
    }
    if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
    if (url.startsWith(GEMS)) {
      const name = decodeURIComponent(url.slice(GEMS.length, -'.json'.length))
      const answer = gems[name]
      if (answer instanceof Response) return Promise.resolve(answer.clone())
      return Promise.resolve(answer ? Response.json({ name, version: '9.9.9', ...answer }) : new Response('This rubygem could not be found.', { status: 404 }))
    }
    const listed = Object.entries(listings).find(([repo]) => url === listing(repo))
    if (listed) return Promise.resolve(Response.json(listed[1]))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// As OSV has GitHub's record of rack's GHSA-22f2-v57c-j9cx.
const ghsa = (id, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: ['CVE-2024-25126'],
  database_specific: { severity: 'MODERATE', github_reviewed: true, cwe_ids: ['CWE-1333'] },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
  affected: [{ package: { name: 'rack', ecosystem: 'RubyGems', purl: 'pkg:gem/rack' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0.4' }, { fixed: '2.2.8.1' }] }] }],
  ...overrides,
})
const repoAdvisory = (id, vulnerabilities, overrides = {}) => ({ ghsa_id: id, state: 'published', summary: `Advisory ${id}`, severity: 'high', vulnerabilities, ...overrides })
const vuln = (name, range, patched, ecosystem = 'rubygems') => ({ package: { ecosystem, name }, vulnerable_version_range: range, ...(patched !== undefined && { patched_versions: patched }) })

describe('gem', () => {
  it('asks OSV of RubyGems for each version, ordered as Gem::Version orders them, and answers its records', async () => {
    const calls = stubAll({
      hits: { 'rack@2.2.0': ['GHSA-22f2-v57c-j9cx'], 'rack@2.2.8.1': [], 'rack@2.2.8.rc1': ['GHSA-22f2-v57c-j9cx'], 'rack@2.2': ['GHSA-22f2-v57c-j9cx'] },
      records: { 'GHSA-22f2-v57c-j9cx': ghsa('GHSA-22f2-v57c-j9cx') },
    })
    const found = await advisories([gem('rack', ['2.2.8.1', '2.2.10', '2.2.0', '2.2.8.rc1']), gem('nokogiri', ['1.13.0']), gem('rack', ['2.2', '2.2.0'])])
    assert.deepEqual(calls[0].body, {
      queries: [
        { package: { name: 'nokogiri', ecosystem: 'RubyGems' }, version: '1.13.0' },
        // 2.2 and 2.2.0 are one version, by their text; a prerelease is
        // below its release; 2.2.10 above 2.2.8.1.
        { package: { name: 'rack', ecosystem: 'RubyGems' }, version: '2.2' },
        { package: { name: 'rack', ecosystem: 'RubyGems' }, version: '2.2.0' },
        { package: { name: 'rack', ecosystem: 'RubyGems' }, version: '2.2.8.rc1' },
        { package: { name: 'rack', ecosystem: 'RubyGems' }, version: '2.2.8.1' },
        { package: { name: 'rack', ecosystem: 'RubyGems' }, version: '2.2.10' },
      ],
    })
    assert.deepEqual(calls.slice(1).map(({ url }) => url), [`${VULN}GHSA-22f2-v57c-j9cx`])
    assert.deepEqual(found, [{
      ecosystem: 'gem',
      name: 'rack',
      source: 'osv',
      id: 'GHSA-22f2-v57c-j9cx',
      ghsa: 'GHSA-22f2-v57c-j9cx',
      url: 'https://github.com/advisories/GHSA-22f2-v57c-j9cx',
      aliases: ['CVE-2024-25126'],
      title: 'Advisory GHSA-22f2-v57c-j9cx',
      severity: 'moderate',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L',
      cwe: ['CWE-1333'],
      versions: ['2.2', '2.2.0', '2.2.8.rc1'],
    }])
  })

  it('reports a version under the GHSA that a malicious package\'s record names, flagged as malware, and under the MAL- record only beyond it', async () => {
    stubAll({
      hits: { 'evil@1.0.0': ['MAL-2025-0001', 'GHSA-aaaa-aaaa-aaaa'], 'evil@1.0.1': ['MAL-2025-0001'] },
      records: {
        'MAL-2025-0001': { id: 'MAL-2025-0001', summary: 'Malicious code in evil (RubyGems)', aliases: ['GHSA-aaaa-aaaa-aaaa'] },
        'GHSA-aaaa-aaaa-aaaa': ghsa('GHSA-aaaa-aaaa-aaaa', { aliases: [], summary: 'Malicious code in evil', database_specific: { severity: 'CRITICAL', cwe_ids: ['CWE-506'] } }),
      },
    })
    const found = await advisories([gem('evil', ['1.0.0', '1.0.1'])])
    assert.deepEqual(found.map(({ id, aliases, severity, malware, versions }) => [id, aliases, severity, malware, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', ['MAL-2025-0001'], 'critical', true, ['1.0.0']],
      ['MAL-2025-0001', ['GHSA-aaaa-aaaa-aaaa'], undefined, true, ['1.0.1']],
    ])
  })

  it('refuses a malformed gem name or version, a platform\'s among them, before any request', async () => {
    const calls = stubAll()
    for (const version of ['1.13.10-x86_64-linux', '1.0.0-rc1', 'v1.0', '1.', '1..0', '~> 1.0', '1.0 ', '', '1'.repeat(257), undefined]) {
      await assert.rejects(advisories([gem('nokogiri', [version])]), /advisories: package\.versions must be a RubyGems version/u, String(version))
    }
    for (const name of ['', '-rack', '_rack', '.rack', '123', 'ra ck', 'rack/core', '../rack', 'x'.repeat(257), undefined]) {
      await assert.rejects(advisories([gem(name, ['1.0.0'])]), /advisories: package\.name must be a gem name/u, String(name))
    }
    for (const name of ['rack', 'RedCloth', 'net-http', 'concurrent-ruby', 'mini_portile2', 'ruby2_keywords', 'a.b', '1password']) {
      assert.deepEqual(await advisories([gem(name, ['1.0.0'])]), [], name)
    }
    assert.equal(calls.length, 8)
  })
})

describe('gem, with a GitHub client', () => {
  const options = { github, repoAdvisories: true }

  it("adds what the gem's repository publishes, its ranges read as Gem::Requirement reads them", async () => {
    const calls = stubAll({
      hits: { 'actionpack@6.1.7': ['GHSA-aaaa-aaaa-aaaa'] },
      records: { 'GHSA-aaaa-aaaa-aaaa': ghsa('GHSA-aaaa-aaaa-aaaa', { aliases: [] }) },
      gems: { actionpack: { source_code_uri: 'https://github.com/rails/rails/tree/v8.1.4.1/actionpack', homepage_uri: 'https://rubyonrails.org' } },
      listings: {
        'rails/rails': [
          // OSV answered for 6.1.7 already: the repository's adds 6.1.10.
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('actionpack', '>= 6.1.0, < 6.1.10.1')]),
          // Semver reads no 6.1.7.1, and would take it as every version.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('actionpack', '>= 6.1.0, < 6.1.7.1')]),
          // A prerelease is below its release, and 7.0 is 7.0.0.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('actionpack', '< 7.0')]),
          // Ended below its one patched version, which semver cannot read.
          repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('actionpack', '>= 7.0.0.rc1', '7.0.4.1')]),
          // One Gem::Requirement cannot read covers every version; another
          // gem's, or another ecosystem's, none.
          repoAdvisory('GHSA-eeee-eeee-eeee', [vuln('actionpack', '^6.1'), vuln('actionview', '< 9'), vuln('actionpack', '< 9', undefined, 'npm')]),
        ],
      },
    })
    const found = await advisories([gem('actionpack', ['6.1.7', '6.1.10', '7.0.0.rc1', '7.0.4.1'])], options)
    assert.deepEqual(found.map(({ source, id, url, range, versions }) => [source, id, url, range, versions]), [
      ['osv', 'GHSA-aaaa-aaaa-aaaa', 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', '>= 6.1.0, < 6.1.10.1', ['6.1.7', '6.1.10']],
      ['repository', 'GHSA-bbbb-bbbb-bbbb', 'https://github.com/rails/rails/security/advisories/GHSA-bbbb-bbbb-bbbb', '>= 6.1.0, < 6.1.7.1', ['6.1.7']],
      ['repository', 'GHSA-cccc-cccc-cccc', 'https://github.com/rails/rails/security/advisories/GHSA-cccc-cccc-cccc', '< 7.0', ['6.1.7', '6.1.10', '7.0.0.rc1']],
      ['repository', 'GHSA-dddd-dddd-dddd', 'https://github.com/rails/rails/security/advisories/GHSA-dddd-dddd-dddd', '>= 7.0.0.rc1, < 7.0.4.1', ['7.0.0.rc1']],
      ['repository', 'GHSA-eeee-eeee-eeee', 'https://github.com/rails/rails/security/advisories/GHSA-eeee-eeee-eeee', '^6.1', ['6.1.7', '6.1.10', '7.0.0.rc1', '7.0.4.1']],
    ])
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(GEMS)).map(({ url }) => url), [`${GEMS}actionpack.json`])
  })

  it("takes the gem's source_code_uri, else its homepage_uri, each a repository or a page in its tree; none, or no such gem, asks no repository", async () => {
    const calls = stubAll({
      gems: {
        rack: { source_code_uri: 'https://github.com/rack/rack', homepage_uri: 'https://github.com/rack/other' },
        'rspec-core': { source_code_uri: 'https://github.com/rspec/rspec/blob/rspec-core-v3.13.6/rspec-core', homepage_uri: 'https://rspec.info' },
        racc: { source_code_uri: null, homepage_uri: 'https://github.com/ruby/racc.git' },
        nokogiri: { source_code_uri: 'https://nokogiri.org/source', homepage_uri: 'HTTPS://GitHub.com/sparklemotion/nokogiri/tree/main' },
        unicorn: { source_code_uri: 'https://bogomips.org/unicorn.git', homepage_uri: 'https://yhbt.net/unicorn/' },
        // A page elsewhere, and one on GitHub that is not of a tree.
        sly: { source_code_uri: 'https://evil.example/https://github.com/a/b/tree/main', homepage_uri: 'https://github.com/a/b/issues' },
      },
      listings: { 'rack/rack': [], 'rspec/rspec': [], 'ruby/racc': [], 'sparklemotion/nokogiri': [] },
    })
    const names = ['nokogiri', 'not-a-gem', 'racc', 'rack', 'rspec-core', 'sly', 'unicorn']
    assert.deepEqual(await advisories(names.map((name) => gem(name, ['1.0.0'])), options), [])
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(GEMS)).map(({ url }) => url), names.map((name) => `${GEMS}${name}.json`))
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('https://api.github.com/')).map(({ url }) => url).toSorted(), [
      listing('rack/rack'), listing('rspec/rspec'), listing('ruby/racc'), listing('sparklemotion/nokogiri'),
    ])
  })

  it('asks rubygems.org one gem a request, ten a second at most, and a repository given without asking it', async () => {
    const names = ['a-gem', 'b-gem', 'c-gem', 'd-gem', 'e-gem', 'f-gem']
    const calls = stubAll({ gems: Object.fromEntries(names.map((name) => [name, { source_code_uri: `https://github.com/acme/${name}` }])), listings: Object.fromEntries([...names, 'given'].map((name) => [`acme/${name}`, []])) })
    await advisories([...names.map((name) => gem(name, ['1.0.0'])), gem('given', ['1.0.0'], { github: 'acme/given' })], options)
    const asked = calls.filter(({ url }) => url.startsWith(GEMS))
    assert.deepEqual(asked.map(({ url }) => url), names.map((name) => `${GEMS}${name}.json`))
    for (const [i, call] of asked.entries()) if (i > 0) assert.ok(call.at - asked[i - 1].at >= 90, `${call.at - asked[i - 1].at} ms after the one before`)
    assert.ok(calls.some(({ url }) => url === listing('acme/given')))
  })

  it('throws where rubygems.org fails, or answers for another gem', async () => {
    stubAll({ gems: { rack: Response.json({ error: 'busy' }, { status: 429 }) } })
    await assert.rejects(advisories([gem('rack', ['2.2.0'])], options), { name: 'HttpError', status: 429 })
    stubAll({ gems: { Rack: Response.json({ name: 'rack', source_code_uri: 'https://github.com/rack/rack' }) } })
    await assert.rejects(advisories([gem('Rack', ['2.0.0'])], options), /advisories: rubygems\.org answered for "rack", not Rack/u)
  })

  it("keeps a gem's repository a month in a caller's store, and none it did not find", async () => {
    const store = mapStore()
    const answers = { gems: { rack: { source_code_uri: 'https://github.com/rack/rack' }, local: { homepage_uri: 'https://example.com' } }, listings: { 'rack/rack': [] } }
    let calls = stubAll(answers)
    const packages = [gem('rack', ['2.2.0']), gem('local', ['1.0.0']), gem('gone', ['1.0.0'])]
    await advisories(packages, { ...options, cache: store })
    assert.equal(store.get('rubygems/repos', 'rack')?.github, 'rack/rack')
    assert.deepEqual(store.log.filter(([op, type]) => op === 'write' && type === 'rubygems/repos').map(([, , key]) => key), ['rack'])
    calls = stubAll(answers)
    await advisories(packages, { ...options, cache: store })
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(GEMS)).map(({ url }) => url).toSorted(), [`${GEMS}gone.json`, `${GEMS}local.json`])
    store.set('rubygems/repos', 'rack', { at: Date.now() - 31 * 24 * 60 * 60 * 1000, name: 'rack', github: 'rack/rack' })
    calls = stubAll(answers)
    await advisories([gem('rack', ['2.2.0'])], { ...options, cache: store })
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(GEMS)).map(({ url }) => url), [`${GEMS}rack.json`])
  })

  describe('through the cache', () => {
    let dir
    after(async () => {
      setCacheDir(false)
      await rm(dir, { recursive: true, force: true })
    })

    it("keeps a gem's repository for the next run, and not one dated in the future", async () => {
      dir = await mkdtemp(join(tmpdir(), 'upstream-gem-cache-'))
      setCacheDir(dir)
      const answers = { gems: { rack: { source_code_uri: 'https://github.com/rack/rack' } }, listings: { 'rack/rack': [] } }
      stubAll(answers)
      await advisories([gem('rack', ['2.2.0'])], options)
      assert.deepEqual(await readdir(join(dir, 'rubygems', 'repos')), ['rack.json'])
      let calls = stubAll({ ...answers, gems: { rack: Response.json({}, { status: 500 }) } })
      await advisories([gem('rack', ['2.2.0'])], options)
      assert.deepEqual(calls.map(({ url }) => url), [BATCH])
      await writeFile(join(dir, 'rubygems', 'repos', 'rack.json'), JSON.stringify({ at: Date.now() + 60_000, name: 'rack', github: 'evil/fork' }))
      calls = stubAll(answers)
      await advisories([gem('rack', ['2.2.0'])], options)
      assert.deepEqual(calls.filter(({ url }) => !url.startsWith('https://api.osv.dev/')).map(({ url }) => url), [`${GEMS}rack.json`])
    })
  })
})
