import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { objectId } from '../src/tree.js'
import { mapStore } from './cache-store.js'
import { deepOf, treeOf } from './github-stub.js'

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
const DB = 'https://api.github.com/repos/rubysec/ruby-advisory-db/'
const DB_SHA = '0123456789abcdef0123456789abcdef01234567'
const blobOf = (text) => objectId('blob', Buffer.from(text)).toString('hex')
const gem = (name, versions, rest = {}) => ({ ecosystem: 'gem', name, versions, ...rest })

// ruby-advisory-db at DB_SHA, of `files` by path beside its README:
// GitHub's answer for a request of it, or undefined for one not of it.
function rubysecAnswer(url, files) {
  if (!url.startsWith(DB)) return undefined
  const { tree, listings } = treeOf(Object.fromEntries(Object.entries({ 'README.md': '# ruby-advisory-db', ...files }).map(([path, text]) => [path, { mode: '100644', type: 'blob', sha: blobOf(text) }])))
  const { pathname, search } = new URL(url)
  const at = pathname.slice(new URL(DB).pathname.length)
  if (at === 'git/ref/heads/master') return Response.json({ ref: 'refs/heads/master', object: { type: 'commit', sha: DB_SHA } })
  if (at === `git/commits/${DB_SHA}`) return Response.json({ sha: DB_SHA, tree: { sha: tree } })
  if (at === `git/trees/${tree}` && search === '?recursive=1') return Response.json({ sha: tree, tree: deepOf(listings, tree), truncated: false })
  const path = at.startsWith('contents/') && search === `?ref=${DB_SHA}` ? at.slice('contents/'.length) : undefined
  if (path !== undefined && Object.hasOwn(files, path)) {
    const bytes = Buffer.from(files[path])
    return Response.json({ type: 'file', path, size: bytes.length, sha: blobOf(files[path]), encoding: 'base64', content: bytes.toString('base64') })
  }
  return Response.json({ message: 'Not Found' }, { status: 404 })
}

// OSV, rubygems.org and GitHub, each answering from what is given: `hits`
// is `name@version` -> ids, `records` id -> record, `gems` name -> the
// gem's document (a Response as is), `listings` repo -> its listing, and
// `rubysec` path -> the text of a file in ruby-advisory-db. `calls` is
// every request, with its parsed body and when it was made.
function stubAll({ hits = {}, records = {}, gems = {}, listings = {}, rubysec = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    // Packagist's advisories, for the one composer package asked: none.
    if (url === 'https://packagist.org/api/security-advisories/') return Promise.resolve(Response.json({ advisories: [] }))
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body, at: Date.now() })
    const fromDb = rubysecAnswer(url, rubysec)
    if (fromDb) return Promise.resolve(fromDb)
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

  it('ends a range below its patched version only where that leaves out none of the versions it names', async () => {
    stubAll({
      gems: { rack: { source_code_uri: 'https://github.com/rack/rack' } },
      listings: {
        'rack/rack': [
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('rack', '~> 3.1', '3.1.3')]),
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('rack', '= 3.1.2', '3.1.2')]),
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('rack', '>= 3.0', '2.2.9')]),
          repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('rack', '>= 3.0, != 3.0.5', '3.1.3')]),
        ],
      },
    })
    const found = await advisories([gem('rack', ['3.0.0', '3.1.2', '3.2.0'])], options)
    assert.deepEqual(found.map(({ id, range, versions }) => [id, range, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', '~> 3.1', ['3.1.2', '3.2.0']],
      ['GHSA-bbbb-bbbb-bbbb', '= 3.1.2', ['3.1.2']],
      ['GHSA-cccc-cccc-cccc', '>= 3.0', ['3.0.0', '3.1.2', '3.2.0']],
      ['GHSA-dddd-dddd-dddd', '>= 3.0, != 3.0.5, < 3.1.3', ['3.0.0', '3.1.2']],
    ])
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
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('https://api.github.com/') && !url.startsWith(DB)).map(({ url }) => url).toSorted(), [
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

describe('gem, from ruby-advisory-db', () => {
  // As ruby-advisory-db has rack's CVE-2024-25126, its patched versions
  // three branches' fixes.
  const RACK_GHSA = `---
gem: rack
cve: 2024-25126
ghsa: 22f2-v57c-j9cx
url: https://github.com/rack/rack/security/advisories/GHSA-22f2-v57c-j9cx
title: Denial of Service Vulnerability in Rack Content-Type Parsing
date: 2024-02-28
description: |
  Carefully crafted content type headers can cause Rack's media type
  parser to take much longer than expected.
cvss_v3: 5.3
unaffected_versions:
  - "< 0.4"
patched_versions:
  - "~> 2.0.9, >= 2.0.9.4"
  - "~> 2.2.8, >= 2.2.8.1"
  - ">= 3.0.9.1"
related:
  url:
    - https://discuss.rubyonrails.org/t/84942
`
  // One with no GHSA, rated by CVSS v2, as many older ones are.
  const RACK_CVE = `---
gem: rack
cve: 2011-5036
osvdb: 78121
url: https://nvd.nist.gov/vuln/detail/CVE-2011-5036
title: 'CVE-2011-5036 rubygem-rack: hash table collisions DoS
  (oCERT-2011-003)'
date: 2011-12-28
description: |
  Rack before 1.1.3 computes hash values for form parameters predictably.
cvss_v2: 5.0
patched_versions:
  - "~> 1.1.3"
  - ">= 1.4.0"
`
  const rubysec = {
    'gems/actionpack/CVE-2016-0751.yml': '---\ngem: actionpack\ncve: 2016-0751\nurl: https://x\ntitle: t\ndate: 2016-01-25\ndescription: d\n',
    'gems/rack/CVE-2011-5036.yml': RACK_CVE,
    'gems/rack/GHSA-22f2-v57c-j9cx.yml': RACK_GHSA,
  }
  const contents = (path) => `${DB}contents/${path}?ref=${DB_SHA}`
  const LISTED = [`${DB}git/ref/heads/master`, `${DB}git/commits/${DB_SHA}`]
  const fromDb = (calls) => calls.filter(({ url }) => url.startsWith(DB)).map(({ url }) => url)

  it("lists the database once, reads the files of the asked gems alone, and matches versions as bundler-audit: neither patched nor unaffected", async () => {
    const calls = stubAll({ rubysec })
    const found = await advisories([gem('rack', ['0.3', '1.1.2', '1.1.3', '2.0.9.3', '2.0.9.4', '2.2.8', '2.2.8.1', '3.1.0']), gem('nokogiri', ['1.13.0'])], { github })
    const db = fromDb(calls)
    assert.deepEqual(db.slice(0, 2), LISTED)
    assert.match(db[2], /\/git\/trees\/[\da-f]{40}\?recursive=1$/u)
    assert.deepEqual(db.slice(3).toSorted(), [contents('gems/rack/CVE-2011-5036.yml'), contents('gems/rack/GHSA-22f2-v57c-j9cx.yml')])
    assert.deepEqual(found, [
      {
        ecosystem: 'gem',
        name: 'rack',
        source: 'rubysec',
        id: 'CVE-2011-5036',
        url: 'https://nvd.nist.gov/vuln/detail/CVE-2011-5036',
        aliases: ['OSVDB-78121'],
        title: 'CVE-2011-5036 rubygem-rack: hash table collisions DoS (oCERT-2011-003)',
        severity: 'moderate',
        cvss: 5,
        cwe: [],
        versions: ['0.3', '1.1.2'],
      },
      {
        ecosystem: 'gem',
        name: 'rack',
        source: 'rubysec',
        id: 'GHSA-22f2-v57c-j9cx',
        ghsa: 'GHSA-22f2-v57c-j9cx',
        url: 'https://github.com/advisories/GHSA-22f2-v57c-j9cx',
        aliases: ['CVE-2024-25126'],
        title: 'Denial of Service Vulnerability in Rack Content-Type Parsing',
        severity: 'moderate',
        cvss: 5.3,
        cwe: [],
        versions: ['1.1.2', '1.1.3', '2.0.9.3', '2.2.8'],
      },
    ])
  })

  it("is one row with OSV's of the same GHSA, or of the GHSA whose alias is its CVE, and gives its description as details where OSV has none", async () => {
    stubAll({
      rubysec,
      hits: { 'rack@1.1.2': ['GHSA-bbbb-bbbb-bbbb'], 'rack@2.2.8': ['GHSA-22f2-v57c-j9cx'] },
      records: {
        'GHSA-22f2-v57c-j9cx': ghsa('GHSA-22f2-v57c-j9cx', { details: 'From OSV.' }),
        'GHSA-bbbb-bbbb-bbbb': ghsa('GHSA-bbbb-bbbb-bbbb', { aliases: ['CVE-2011-5036'], database_specific: { severity: 'HIGH' } }),
      },
    })
    const found = await advisories([gem('rack', ['1.1.2', '2.0.9.3', '2.2.8'])], { github, details: true })
    assert.deepEqual(found.map(({ source, id, aliases, severity, details, versions }) => [source, id, aliases, severity, details, versions]), [
      ['osv', 'GHSA-22f2-v57c-j9cx', ['CVE-2024-25126'], 'moderate', 'From OSV.', ['1.1.2', '2.0.9.3', '2.2.8']],
      ['osv', 'GHSA-bbbb-bbbb-bbbb', ['CVE-2011-5036', 'OSVDB-78121'], 'high', 'Rack before 1.1.3 computes hash values for form parameters predictably.\n', ['1.1.2']],
    ])
    stubAll({ rubysec })
    const alone = await advisories([gem('rack', ['2.2.8'])], { github, details: true })
    assert.equal(alone[0].details, "Carefully crafted content type headers can cause Rack's media type\nparser to take much longer than expected.\n")
  })

  it('asks nothing of it without a GitHub client, or without a gem asked', async () => {
    let calls = stubAll({ rubysec })
    await advisories([gem('rack', ['2.2.8'])])
    assert.deepEqual(fromDb(calls), [])
    calls = stubAll({ rubysec })
    await advisories([{ ecosystem: 'composer', name: 'acme/app', versions: ['1.0.0'] }], { github })
    assert.deepEqual(fromDb(calls), [])
  })

  it('keeps the listing 90 minutes and each file for good, by its blob', async () => {
    const store = mapStore()
    const packages = [gem('rack', ['2.2.8'])]
    stubAll({ rubysec })
    const first = await advisories(packages, { github, cache: store })
    assert.deepEqual(store.log.filter(([op]) => op === 'write').map(([, type, key]) => [type, key]).toSorted(), [
      ['rubysec/advisories', blobOf(RACK_CVE)], ['rubysec/advisories', blobOf(RACK_GHSA)], ['rubysec/index', 'gems'],
    ].toSorted())
    let calls = stubAll({ rubysec })
    assert.deepEqual(await advisories(packages, { github, cache: store }), first)
    assert.deepEqual(fromDb(calls), [])
    store.set('rubysec/index', 'gems', { ...store.get('rubysec/index', 'gems'), at: Date.now() - 91 * 60 * 1000 })
    calls = stubAll({ rubysec })
    assert.deepEqual(await advisories(packages, { github, cache: store }), first)
    assert.deepEqual(fromDb(calls).length, 3)
  })

  it("refuses a file of another gem, one it can't read, and one that is not the blob listed", async () => {
    stubAll({ rubysec: { 'gems/rack/CVE-1.yml': RACK_CVE.replace('gem: rack', 'gem: rails') } })
    await assert.rejects(advisories([gem('rack', ['1.0'])], { github }), /gems\/rack\/CVE-1\.yml is of "rails", not rack/u)
    stubAll({ rubysec: { 'gems/rack/CVE-1.yml': RACK_CVE.replace('cvss_v2: 5.0', 'cvss_v2: 5.0\ncvss_v2: 6.0') } })
    await assert.rejects(advisories([gem('rack', ['1.0'])], { github }), /gems\/rack\/CVE-1\.yml: duplicate key "cvss_v2"/u)
    const calls = stubAll({ rubysec: { 'gems/rack/CVE-1.yml': RACK_CVE } })
    const real = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const answer = await real(url, init)
      if (!String(url).includes('/contents/')) return answer
      const file = await answer.json()
      return Response.json({ ...file, content: Buffer.from(RACK_GHSA).toString('base64'), size: RACK_GHSA.length, sha: blobOf(RACK_GHSA) })
    }
    await assert.rejects(advisories([gem('rack', ['1.0'])], { github }), /gems\/rack\/CVE-1\.yml at [\da-f]{40} is not blob [\da-f]{40}/u)
    assert.ok(calls.some(({ url }) => url.includes('/contents/')))
  })
})

describe('ruby, from ruby-advisory-db', () => {
  // As rubies/ruby has CVE-2026-46727: Ruby 3.4 and earlier are unaffected.
  const RUBY_NEW = `---
engine: ruby
cve: 2026-46727
ghsa: jfc8-2xw7-c79m
url: https://nvd.nist.gov/vuln/detail/CVE-2026-46727
title: Use-after-free in pthread-based getaddrinfo timeout handler
date: 2026-05-20
description: |
  A race condition leading to a use-after-free.
cvss_v3: 8.1
unaffected_versions:
  - "< 4.0"
patched_versions:
  - ">= 4.0.5"
`
  // An old one, fixed by patchlevel, its CVSS v2 score `.17` as mrubyc's
  // CVE-2025-13397 has it.
  const RUBY_OLD = `---
engine: ruby
cve: 2008-2664
url: https://www.ruby-lang.org/en/news/2008/06/20/arbitrary-code-execution-vulnerabilities/
title: Arbitrary code execution vulnerabilities
date: 2008-06-20
description: |
  Multiple vulnerabilities in Ruby.
cvss_v2: .17
patched_versions:
  - "~> 1.8.7.22"
  - ">= 1.9.0.2"
`
  const JRUBY = `---
engine: jruby
osvdb: 94644
url: https://www.jruby.org/2011/05/24/jruby-1-6-2.html
title: JRuby Null Byte Request Arbitrary File Access
date: 2010-05-26
description: |
  JRuby fails to check for null bytes in certain file operations.
patched_versions:
  - ">= 1.6.2"
`
  const rubysec = {
    'gems/rack/CVE-1.yml': '---\ngem: rack\ncve: 2011-5036\nurl: https://x\ntitle: t\ndate: 2011-12-28\ndescription: d\npatched_versions:\n  - ">= 1.4.0"\n',
    'rubies/jruby/OSVDB-94644.yml': JRUBY,
    'rubies/ruby/CVE-2008-2664.yml': RUBY_OLD,
    'rubies/ruby/CVE-2026-46727.yml': RUBY_NEW,
  }
  const ruby = (name, versions) => ({ ecosystem: 'ruby', name, versions })
  const contents = (path) => `${DB}contents/${path}?ref=${DB_SHA}`
  const fromDb = (calls) => calls.filter(({ url }) => url.startsWith(DB)).map(({ url }) => url)

  it("lists the database once for gems and Rubies alike, reads the asked engine's files alone, and matches a version with its patchlevel", async () => {
    const calls = stubAll({ rubysec })
    const found = await advisories([ruby('ruby', ['4.0.4p0', '4.0.5p10', '3.4.1p1', '1.8.7p21', '1.8.7p22', '3.0.0.preview1p-1']), gem('rack', ['1.0.0'])], { github })
    const db = fromDb(calls)
    assert.equal(db.filter((url) => url.includes('/trees/')).length, 1)
    assert.deepEqual(db.filter((url) => url.includes('/contents/')).toSorted(), [contents('gems/rack/CVE-1.yml'), contents('rubies/ruby/CVE-2008-2664.yml'), contents('rubies/ruby/CVE-2026-46727.yml')])
    assert.deepEqual(found.filter(({ ecosystem }) => ecosystem === 'ruby').map(({ name, source, id, url, aliases, severity, cvss, versions }) => [name, source, id, url, aliases, severity, cvss, versions]), [
      // 1.8.7p21 is 1.8.7.21, below `~> 1.8.7.22`.
      ['ruby', 'rubysec', 'CVE-2008-2664', 'https://www.ruby-lang.org/en/news/2008/06/20/arbitrary-code-execution-vulnerabilities/', [], 'low', 0.17, ['1.8.7p21']],
      ['ruby', 'rubysec', 'GHSA-jfc8-2xw7-c79m', 'https://github.com/advisories/GHSA-jfc8-2xw7-c79m', ['CVE-2026-46727'], 'high', 8.1, ['4.0.4p0']],
    ])
  })

  it('asks another engine by its own version', async () => {
    stubAll({ rubysec })
    const found = await advisories([ruby('jruby', ['1.6.1', '9.4.5.0'])], { github })
    assert.deepEqual(found.map(({ name, id, aliases, versions }) => [name, id, aliases, versions]), [['jruby', 'OSVDB-94644', [], ['1.6.1']]])
  })

  it('refuses a Ruby without a GitHub client, or a malformed engine or version, before any request', async () => {
    const calls = stubAll({ rubysec })
    await assert.rejects(advisories([ruby('ruby', ['3.3.6p108'])]), /advisories: ruby packages need a github client/u)
    for (const name of ['Ruby', 'j ruby', '', 'ruby/jruby', '1ruby', undefined]) {
      await assert.rejects(advisories([ruby(name, ['3.3.6'])], { github }), /advisories: package\.name must be a Ruby engine/u, String(name))
    }
    for (const version of ['ruby 3.3.6p108', 'v3.3.6', '3.3', '3.3.6-p108', '3.3.6p', '3.3.6p01', '3.3.6p-2', '', undefined]) {
      await assert.rejects(advisories([ruby('ruby', [version])], { github }), /advisories: package\.versions must be a Ruby version as Bundler writes one/u, String(version))
    }
    assert.deepEqual(calls, [])
  })
})
