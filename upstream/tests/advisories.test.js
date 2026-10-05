import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError, advisories } from '../advisories.js'
import { createClient } from '../github.js'

const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// `{ name, version }` pairs as the packages advisories takes, with
// `defaults` for options.
const as = (ecosystem, defaults) => (pairs, options = defaults) => advisories(pairs.map(({ name, version, ...rest }) => ({ ecosystem, name, versions: [version], ...rest })), options)
const npm = as('npm')

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const advisory = (ghsa, vulnerabilities, overrides = {}) => ({ ghsa_id: ghsa, state: 'published', summary: `Advisory ${ghsa}`, severity: 'high', cwe_ids: [], vulnerabilities, ...overrides })
const vuln = (name, range, ecosystem = 'npm') => ({ package: { ecosystem, name }, vulnerable_version_range: range })

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

// Answers each bulk request with `respond(body)`, and keeps every body.
function stubRegistry(respond) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), method: init.method, body })
    return Promise.resolve(Response.json(respond(body)))
  }
  return calls
}

const row = (overrides = {}) => ({
  id: 1,
  url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
  title: 'Prototype Pollution in minimist',
  severity: 'critical',
  vulnerable_versions: '>=1.0.0 <1.2.6',
  cwe: ['CWE-1321'],
  cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
  ...overrides,
})

describe('advisories', () => {
  it('refuses a package it cannot take, or options, before any request', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    const ok = { ecosystem: 'npm', name: 'lodash', versions: ['1.0.0'] }
    for (const packages of ['lodash', undefined, ok]) {
      await assert.rejects(advisories(packages), /advisories: packages must be an iterable of \{ ecosystem, name, github\?, versions \}/u, String(packages))
    }
    for (const [pkg, error] of [
      [null, /advisories: package must be an options object/u],
      [{ ...ok, ecosystem: 'pypi' }, /advisories: package\.ecosystem must be one of npm, cargo, composer, soldeer, github/u],
      [{ ...ok, ecosystem: '__proto__' }, /advisories: package\.ecosystem must be one of/u],
      [{ ...ok, versions: [] }, /advisories: package\.versions must be a non-empty array/u],
      [{ ...ok, versions: '1.0.0' }, /advisories: package\.versions must be a non-empty array/u],
      [{ ...ok, version: '1.0.0' }, /advisories: unknown option package\.version/u],
      [{ ...ok, github: 'lodash' }, /advisories: package\.github must be "owner\/name"/u],
      [{ ecosystem: 'github', name: 'acme/app', versions: ['1.0.0'], github: 'acme/app' }, /advisories: a github package is its own repository/u],
    ]) {
      await assert.rejects(advisories([ok, pkg]), error, JSON.stringify(pkg))
    }
    await assert.rejects(advisories([{ ...ok, github: 'acme/a' }, { ...ok, github: 'acme/b' }]), /advisories: lodash is given two repositories/u)
    await assert.rejects(advisories([ok], { repoAdvisories: true }), /advisories: repoAdvisories needs a github client/u)
    await assert.rejects(advisories([{ ecosystem: 'github', name: 'acme/app', versions: ['1.0.0'] }]), /advisories: github packages need a github client/u)
    await assert.rejects(advisories([ok], { github: {} }), /advisories: github must be a GitHub client from createClient/u)
    await assert.rejects(advisories([ok], { gitHub: {} }), /advisories: unknown option gitHub/u)
    assert.deepEqual(calls, [])
  })

  it('makes no request for no packages', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    assert.deepEqual(await advisories([]), [])
    assert.deepEqual(calls, [])
  })

  it('takes one repository spelled in two cases as one', async () => {
    stubRegistry(() => ({}))
    const pkg = { ecosystem: 'npm', name: 'lodash', versions: ['1.0.0'] }
    assert.deepEqual(await advisories([{ ...pkg, github: 'Lodash/Lodash' }, { ...pkg, github: 'lodash/lodash' }]), [])
  })
})

describe('npm', () => {
  it('answers one entry per package and range, with the asked versions it covers', async () => {
    const calls = stubRegistry(() => ({
      minimist: [row({ id: 1, vulnerable_versions: '<0.2.4' }), row({ id: 2 })],
      lodash: [row({ id: 3, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', vulnerable_versions: '<4.17.21', cwe: undefined, cvss: { score: 0, vectorString: null } })],
    }))
    const found = await npm([
      { name: 'minimist', version: '1.2.0' },
      { name: 'lodash', version: '4.17.21' },
      { name: 'lodash', version: '4.17.15' },
      { name: 'minimist', version: '1.2.0' },
    ])
    assert.deepEqual(calls, [{ url: BULK, method: 'POST', body: { lodash: ['4.17.15', '4.17.21'], minimist: ['1.2.0'] } }])
    assert.deepEqual(found, [
      { ecosystem: 'npm', name: 'lodash', source: 'registry', id: 'GHSA-35jh-r3h4-6jhm', ghsa: 'GHSA-35jh-r3h4-6jhm', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', aliases: [], title: 'Command Injection in lodash', severity: 'high', cwe: [], range: '<4.17.21', versions: ['4.17.15'] },
      {
        ecosystem: 'npm', name: 'minimist', source: 'registry', id: 'GHSA-xvch-5gv4-984h', ghsa: 'GHSA-xvch-5gv4-984h', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', aliases: [],
        title: 'Prototype Pollution in minimist', severity: 'critical',
        cvss: 9.8, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe: ['CWE-1321'], range: '>=1.0.0 <1.2.6', versions: ['1.2.0'],
      },
    ])
  })

  it('takes a GHSA only from a GitHub advisory page, and ids a row without one by the registry, with no page', async () => {
    stubRegistry(() => ({
      pkg: [
        row({ id: 1, url: 'https://npmjs.com/advisories/1' }),
        row({ id: 2, url: 'https://evil.example/advisories/GHSA-xvch-5gv4-984h' }),
        row({ id: 3, url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h/x' }),
      ],
    }))
    const found = await npm([{ name: 'pkg', version: '1.0.0' }])
    assert.deepEqual(found.map(({ id, ghsa, url }) => [id, ghsa, url]), [['npm:1', undefined, undefined], ['npm:2', undefined, undefined], ['npm:3', undefined, undefined]])
  })

  it('asks for 250 names at a time, in name order', async () => {
    const calls = stubRegistry(() => ({}))
    const names = Array.from({ length: 251 }, (_, i) => `pkg-${String(i).padStart(3, '0')}`)
    assert.deepEqual(await npm(names.toReversed().map((name) => ({ name, version: '1.0.0' }))), [])
    assert.deepEqual(calls.map((call) => Object.keys(call.body)), [names.slice(0, 250), names.slice(250)])
  })

  it('refuses a malformed name or version, before any request', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    for (const name of ['../x', ['lodash'], undefined]) {
      await assert.rejects(npm([{ name: 'ok', version: '1.0.0' }, { name, version: '1.0.0' }]), /advisories: package\.name must be an npm package name/u, JSON.stringify(name))
    }
    for (const version of ['^1.0.0', 'file:../x', '1.0.0+build', 'latest', undefined]) {
      await assert.rejects(npm([{ name: 'lodash', version }]), /advisories: package\.versions must be an exact semver version/u, String(version))
    }
    assert.deepEqual(calls, [])
  })

  it('refuses an answer about a name not asked, or one that is malformed', async () => {
    for (const [answer, error] of [
      [[], /expected an object from the registry/u],
      [null, /expected an object from the registry/u],
      [{ other: [] }, /the registry answered for "other", which was not asked/u],
      [{ pkg: row() }, /malformed advisories for pkg/u],
      [{ pkg: [row({ id: '1' })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ url: null })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ vulnerable_versions: undefined })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ cwe: 'CWE-1321' })] }, /malformed advisories for pkg/u],
    ]) {
      stubRegistry(() => answer)
      await assert.rejects(npm([{ name: 'pkg', version: '1.0.0' }]), error, JSON.stringify(answer))
    }
  })

  it('matches ranges as npm audit does: a prerelease inside one, and every version for one semver cannot read', async () => {
    const npmRow = (id, range) => row({ id, url: `https://npmjs.com/advisories/${id}`, vulnerable_versions: range })
    stubRegistry(() => ({ pkg: [npmRow(1, '<1.2.6'), npmRow(2, 'not a range'), npmRow(3, '>=2.0.0')] }))
    const found = await npm([{ name: 'pkg', version: '1.0.0-beta.1' }, { name: 'pkg', version: '1.3.0' }])
    assert.deepEqual(found.map(({ id, versions }) => [id, versions]), [['npm:1', ['1.0.0-beta.1']], ['npm:2', ['1.0.0-beta.1', '1.3.0']]])
  })

  it('keeps only what is in its documented shape: a severity word, a score out of 10, a CVSS vector, CWE ids', async () => {
    stubRegistry(() => ({
      pkg: [
        row({ id: 1, url: 'https://npmjs.com/advisories/1', severity: 'MEDIUM', cvss: { score: 10, vectorString: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }, cwe: ['CWE-79', 'NVD-CWE-Other', 'CWE-'] }),
        row({ id: 2, url: 'https://npmjs.com/advisories/2', severity: 'severe', cvss: { score: 11, vectorString: 'CVSS:3.1/AV:N\u001B[2J' } }),
        row({ id: 3, url: 'https://npmjs.com/advisories/3', cvss: { score: -1, vectorString: 7 } }),
      ],
    }))
    const found = await npm([{ name: 'pkg', version: '1.2.0' }])
    assert.deepEqual(found.map(({ id, severity, cvss, cvssVector, cwe }) => ({ id, severity, cvss, cvssVector, cwe })), [
      { id: 'npm:1', severity: 'moderate', cvss: 10, cvssVector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', cwe: ['CWE-79'] },
      { id: 'npm:2', severity: undefined, cvss: undefined, cvssVector: undefined, cwe: ['CWE-1321'] },
      { id: 'npm:3', severity: 'critical', cvss: undefined, cvssVector: undefined, cwe: ['CWE-1321'] },
    ])
  })

  it('refuses a title that is not well-formed text', async () => {
    stubRegistry(() => ({ pkg: [row({ title: 'a\uD800b' })] }))
    await assert.rejects(npm([{ name: 'pkg', version: '1.2.0' }]), /advisories: malformed advisories for pkg/u)
  })

  it('throws an HttpError for a failed request', async () => {
    globalThis.fetch = () => Promise.resolve(Response.json({ error: 'nope' }, { status: 503 }))
    await assert.rejects(npm([{ name: 'pkg', version: '1.0.0' }]), (err) => err instanceof HttpError && err.status === 503)
  })
})

describe('npm, with a GitHub client', () => {
  const REPO_ADVISORIES = listing('acme/mono')
  const GIVEN = listing('acme/given')
  const repoAdvisory = (ghsa, vulnerabilities, overrides = {}) => ({
    ghsa_id: ghsa,
    state: 'published',
    summary: `Advisory ${ghsa}`,
    severity: 'medium',
    cwe_ids: ['CWE-79'],
    cvss_severities: { cvss_v3: { vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', score: 6.1 }, cvss_v4: { vector_string: null, score: null } },
    vulnerabilities,
    ...overrides,
  })

  // The registry (bulk advisories, and `latest` documents naming each
  // package's repo) and GitHub, each answering from what is given.
  function stubAll({ bulk = {}, repos = {}, github: answers = {} }) {
    const calls = []
    globalThis.fetch = (url, init = {}) => {
      url = String(url)
      calls.push(url)
      if (url === BULK) return Promise.resolve(Response.json(bulk))
      const latest = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/u.exec(url)
      if (latest) {
        const name = decodeURIComponent(latest[1])
        return Promise.resolve(Object.hasOwn(repos, name) ? Response.json({ name, repository: { url: `git+https://github.com/${repos[name]}.git` } }) : Response.json({ error: 'Not found' }, { status: 404 }))
      }
      if (Object.hasOwn(answers, url)) {
        const answer = answers[url]
        return Promise.resolve(answer instanceof Response ? answer.clone() : Response.json(answer))
      }
      return Promise.reject(new Error(`unexpected request: ${url} ${init.method ?? 'GET'}`))
    }
    return calls
  }

  it('adds what the repository publishes and the registry does not have, for the packages it is named for', async () => {
    stubAll({
      bulk: { 'mono-a': [row({ id: 7, url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', vulnerable_versions: '<1.0.1' })] },
      repos: { 'mono-a': 'acme/mono', 'mono-b': 'acme/mono' },
      github: {
        [REPO_ADVISORIES]: [
          // Reviewed, and the registry's range stops short of 2.0.5, which the
          // repository's newer one covers: only 2.0.5 is added.
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('mono-a', '< 3.0.0')]),
          // Two disjoint ranges are two entries, and two rows.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('mono-a', '>= 1.0.0, < 1.2.6'), vuln('mono-a', '>= 2.0.0, < 2.1.0'), vuln('mono-a', '>= 3.0.0')]),
          // Another package in the repo, one not asked, another ecosystem.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('mono-b', 'not a range'), vuln('mono-c', '< 9.0.0'), vuln('mono-a', '< 9.0.0', 'pip')], { severity: null, cvss_severities: null, cwe_ids: null }),
          repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('mono-a', '< 9.0.0')], { withdrawn_at: '2026-01-01T00:00:00Z' }),
        ],
      },
    })
    const found = await npm([
      { name: 'mono-a', version: '1.0.0' },
      { name: 'mono-a', version: '2.0.5' },
      { name: 'mono-b', version: '4.0.0' },
    ], { github, repoAdvisories: true })
    // Its own page, which GitHub's database may not have yet.
    const page = (ghsa) => `https://github.com/acme/mono/security/advisories/${ghsa}`
    const common = { ecosystem: 'npm', source: 'repository', aliases: [], severity: 'moderate', cvss: 6.1, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe: ['CWE-79'] }
    assert.deepEqual(found, [
      {
        ecosystem: 'npm', name: 'mono-a', source: 'registry', id: 'GHSA-aaaa-aaaa-aaaa', ghsa: 'GHSA-aaaa-aaaa-aaaa', url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', aliases: [],
        title: 'Prototype Pollution in minimist', severity: 'critical',
        cvss: 9.8, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe: ['CWE-1321'], range: '<1.0.1', versions: ['1.0.0'],
      },
      { ...common, name: 'mono-a', id: 'GHSA-aaaa-aaaa-aaaa', ghsa: 'GHSA-aaaa-aaaa-aaaa', url: page('GHSA-aaaa-aaaa-aaaa'), title: 'Advisory GHSA-aaaa-aaaa-aaaa', range: '< 3.0.0', versions: ['2.0.5'] },
      { ...common, name: 'mono-a', id: 'GHSA-bbbb-bbbb-bbbb', ghsa: 'GHSA-bbbb-bbbb-bbbb', url: page('GHSA-bbbb-bbbb-bbbb'), title: 'Advisory GHSA-bbbb-bbbb-bbbb', range: '>= 1.0.0, < 1.2.6', versions: ['1.0.0'] },
      { ...common, name: 'mono-a', id: 'GHSA-bbbb-bbbb-bbbb', ghsa: 'GHSA-bbbb-bbbb-bbbb', url: page('GHSA-bbbb-bbbb-bbbb'), title: 'Advisory GHSA-bbbb-bbbb-bbbb', range: '>= 2.0.0, < 2.1.0', versions: ['2.0.5'] },
      {
        ecosystem: 'npm', name: 'mono-b', source: 'repository', id: 'GHSA-cccc-cccc-cccc', ghsa: 'GHSA-cccc-cccc-cccc', url: page('GHSA-cccc-cccc-cccc'), aliases: [], title: 'Advisory GHSA-cccc-cccc-cccc', cwe: [], range: 'not a range', versions: ['4.0.0'],
      },
    ])
  })

  it('asks no repository without repoAdvisories, and with it, one given as is and the rest looked up, each once', async () => {
    const answers = { repos: { 'mono-a': 'acme/mono', 'mono-b': 'acme/mono' }, github: { [REPO_ADVISORIES]: [], [GIVEN]: [] } }
    const packages = [{ name: 'mono-a', version: '1.0.0' }, { name: 'mono-b', version: '1.0.0' }, { name: 'given', version: '1.0.0', github: 'acme/given' }]
    let calls = stubAll(answers)
    assert.deepEqual(await npm(packages, { github }), [])
    assert.deepEqual(calls, [BULK])
    calls = stubAll(answers)
    assert.deepEqual(await npm([...packages, { name: 'norepo', version: '1.0.0' }], { github, repoAdvisories: true }), [])
    assert.deepEqual(calls.filter((url) => url.startsWith('https://registry.npmjs.org/') && url !== BULK).toSorted(), ['mono-a', 'mono-b', 'norepo'].map((name) => `https://registry.npmjs.org/${name}/latest`))
    assert.deepEqual(calls.filter((url) => url.startsWith('https://api.github.com/')).toSorted(), [GIVEN, REPO_ADVISORIES])
  })

  it('asks one repository spelled in two cases once', async () => {
    const calls = stubAll({ github: { [REPO_ADVISORIES]: [] } })
    await npm([{ name: 'mono-a', version: '1.0.0', github: 'acme/mono' }, { name: 'mono-b', version: '1.0.0', github: 'Acme/Mono' }], { github, repoAdvisories: true })
    assert.deepEqual(calls.filter((url) => url.startsWith('https://api.github.com/')), [REPO_ADVISORIES])
  })

  it('skips a repository gone, renamed or blocked, and throws on any other failure', async () => {
    const one = [{ name: 'mono-a', version: '1.0.0', github: 'acme/mono' }]
    const options = { github, repoAdvisories: true }
    for (const status of [301, 404, 410, 451]) {
      const answer = status === 301 ? new Response('', { status, headers: { location: 'https://api.github.com/repositories/1' } }) : Response.json({ message: 'x' }, { status })
      stubAll({ github: { [REPO_ADVISORIES]: answer } })
      assert.deepEqual(await npm(one, options), [], String(status))
    }
    for (const status of [403, 500]) {
      stubAll({ github: { [REPO_ADVISORIES]: Response.json({ message: 'x' }, { status }) } })
      await assert.rejects(npm(one, options), (err) => err instanceof HttpError && err.status === status, String(status))
    }
    stubAll({ github: { [REPO_ADVISORIES]: [{ ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'draft', summary: 'x' }] } })
    await assert.rejects(npm(one, options), /advisories: malformed advisory from acme\/mono/u)
  })

  it("throws when a package's repository cannot be looked up, and skips one the registry does not have", async () => {
    const one = [{ name: 'mono-a', version: '1.0.0' }]
    stubAll({ repos: {} })
    assert.deepEqual(await npm(one, { github, repoAdvisories: true }), [])
    for (const status of [429, 500]) {
      const calls = []
      globalThis.fetch = (url) => {
        calls.push(String(url))
        return Promise.resolve(String(url) === BULK ? Response.json({}) : Response.json({ error: 'x' }, { status }))
      }
      await assert.rejects(npm(one, { github, repoAdvisories: true }), (err) => err instanceof HttpError && err.status === status, String(status))
      assert.deepEqual(calls, [BULK, 'https://registry.npmjs.org/mono-a/latest'])
    }
    globalThis.fetch = (url) => Promise.resolve(String(url) === BULK ? Response.json({}) : Response.json({ name: 'other' }))
    await assert.rejects(npm(one, { github, repoAdvisories: true }), /lookUpPackageRepo: the registry answered for "other", not mono-a/u)
  })
})

describe('github', () => {
  const OZ = listing('OpenZeppelin/openzeppelin-contracts')
  const repo = (versions) => advisories([{ ecosystem: 'github', name: 'OpenZeppelin/openzeppelin-contracts', versions }], { github })

  it("counts every range a repository's advisories list, whichever package, once each", async () => {
    const calls = stubUrls({
      [OZ]: [
        advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3'), vuln('@openzeppelin/contracts-upgradeable', '>= 4.0.0, < 4.9.3')]),
        advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '>= 5.0.0, < 5.0.2'), { package: { ecosystem: 'other', name: 'x' }, vulnerable_version_range: null }]),
        advisory('GHSA-cccc-cccc-cccc', [vuln('@openzeppelin/contracts', '< 9.0.0')], { withdrawn_at: '2026-01-01T00:00:00Z' }),
      ],
    })
    const found = await repo(['4.9.0', '5.0.1'])
    assert.deepEqual(calls, [OZ])
    assert.deepEqual(found.map(({ ghsa, range, versions }) => [ghsa, range, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', '>= 4.0.0, < 4.9.3', ['4.9.0']],
      ['GHSA-bbbb-bbbb-bbbb', '>= 5.0.0, < 5.0.2', ['5.0.1']],
      ['GHSA-bbbb-bbbb-bbbb', '', ['4.9.0', '5.0.1']],
    ])
    assert.deepEqual(found[0], {
      ecosystem: 'github', name: 'OpenZeppelin/openzeppelin-contracts', source: 'repository', id: 'GHSA-aaaa-aaaa-aaaa', ghsa: 'GHSA-aaaa-aaaa-aaaa',
      url: 'https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-aaaa-aaaa-aaaa', aliases: [], title: 'Advisory GHSA-aaaa-aaaa-aaaa', severity: 'high', cwe: [], range: '>= 4.0.0, < 4.9.3', versions: ['4.9.0'],
    })
  })

  it('merges one repository spelled in two cases, under the first spelling', async () => {
    const calls = stubUrls({ [OZ]: [advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '< 5.0.0')])] })
    const found = await advisories([
      { ecosystem: 'github', name: 'OpenZeppelin/openzeppelin-contracts', versions: ['4.9.0'] },
      { ecosystem: 'github', name: 'openzeppelin/OpenZeppelin-Contracts', versions: ['4.8.0'] },
    ], { github })
    assert.deepEqual(calls, [OZ])
    assert.deepEqual(found.map(({ name, url, versions }) => [name, url, versions]), [
      ['OpenZeppelin/openzeppelin-contracts', 'https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-aaaa-aaaa-aaaa', ['4.8.0', '4.9.0']],
    ])
  })

  it('takes a branch name or 0.0.0 as every version', async () => {
    stubUrls({
      [OZ]: [
        advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3')]),
        advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '= 5.0.1')]),
      ],
    })
    // A tag or build metadata is still a version, matched as one.
    const found = await repo(['master', 'release/1.x', '0.0.0', 'v4.9.0', '4.9.1+linux', '1.2.3+linux', '5.0.1', '6.0.0'])
    assert.deepEqual(found.map(({ ghsa, versions }) => [ghsa, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', ['0.0.0', '4.9.1+linux', 'master', 'release/1.x', 'v4.9.0']],
      ['GHSA-bbbb-bbbb-bbbb', ['0.0.0', '5.0.1', 'master', 'release/1.x']],
    ])
  })

  it('skips a repository gone, and throws on any other failure', async () => {
    stubUrls({ [OZ]: Response.json({ message: 'Not Found' }, { status: 404 }) })
    assert.deepEqual(await repo(['4.9.0']), [])
    stubUrls({ [OZ]: Response.json({ message: 'rate limited' }, { status: 403 }) })
    await assert.rejects(repo(['4.9.0']), { name: 'HttpError', status: 403 })
    stubUrls({ [OZ]: [advisory('GHSA-aaaa-aaaa-aaaa', [{ package: null, vulnerable_version_range: 42 }])] })
    await assert.rejects(repo(['4.9.0']), /advisories: malformed range in GHSA-aaaa-aaaa-aaaa/u)
  })

  it('refuses what is not `owner/name` at a version or branch, before any request', async () => {
    const calls = stubUrls({})
    for (const name of ['openzeppelin-contracts', 'a/b/c', '../x', undefined]) {
      await assert.rejects(advisories([{ ecosystem: 'github', name, versions: ['1.0.0'] }], { github }), /advisories: package\.name must be "owner\/name"/u, String(name))
    }
    for (const version of ['', 'a b', 'x..y', 'main.lock', '-x', ['main'], undefined]) {
      await assert.rejects(repo([version]), /advisories: package\.versions must be a version or a branch name/u, String(version))
    }
    assert.deepEqual(calls, [])
  })
})

describe('soldeer', () => {
  const soldeer = as('soldeer', { github })
  const projectUrl = (name) => `https://api.soldeer.xyz/api/v1/project?project_name=${encodeURIComponent(name)}`
  // Soldeer's answer for a project with that `github_url`, or none without.
  const project = (name, githubUrl) => [projectUrl(name), { data: githubUrl === undefined ? [] : [{ name, github_url: githubUrl }] }]

  it("counts every range the project's repository lists, whichever package, with the repository from Soldeer", async () => {
    const answers = Object.fromEntries([
      project('@openzeppelin-contracts', 'https://github.com/OpenZeppelin/openzeppelin-contracts'),
      project('forge-std', 'https://github.com/foundry-rs/forge-std'),
      project('unlinked', ''),
      project('elsewhere', 'https://gitlab.com/acme/elsewhere'),
      project('not-on-soldeer'),
      [listing('OpenZeppelin/openzeppelin-contracts'), [
        advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3')]),
        advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '>= 5.0.0, < 5.0.2')]),
      ]],
      [listing('foundry-rs/forge-std'), []],
    ])
    const calls = stubUrls(answers)
    const found = await advisories([
      { ecosystem: 'soldeer', name: '@openzeppelin-contracts', versions: ['5.0.1', '4.9.0', '5.7.0-rc.0'] },
      ...['forge-std', 'unlinked', 'elsewhere', 'not-on-soldeer'].map((name) => ({ ecosystem: 'soldeer', name, versions: ['1.0.0'] })),
    ], { github })
    assert.deepEqual(calls.toSorted(), Object.keys(answers).toSorted())
    assert.deepEqual(found.map(({ name, ghsa, range, versions }) => [name, ghsa, range, versions]), [
      ['@openzeppelin-contracts', 'GHSA-aaaa-aaaa-aaaa', '>= 4.0.0, < 4.9.3', ['4.9.0']],
      ['@openzeppelin-contracts', 'GHSA-bbbb-bbbb-bbbb', '>= 5.0.0, < 5.0.2', ['5.0.1']],
    ])
    assert.deepEqual(found[0], {
      ecosystem: 'soldeer', name: '@openzeppelin-contracts', source: 'repository', id: 'GHSA-aaaa-aaaa-aaaa', ghsa: 'GHSA-aaaa-aaaa-aaaa',
      url: 'https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-aaaa-aaaa-aaaa', aliases: [], title: 'Advisory GHSA-aaaa-aaaa-aaaa', severity: 'high', cwe: [], range: '>= 4.0.0, < 4.9.3', versions: ['4.9.0'],
    })
  })

  it('asks a repository given without asking Soldeer', async () => {
    const calls = stubUrls({ [listing('acme/fork')]: [advisory('GHSA-aaaa-aaaa-aaaa', [vuln('anything', '< 2.0.0')])] })
    const found = await soldeer([{ name: 'forge-std', version: '1.9.2', github: 'acme/fork' }])
    assert.deepEqual(found.map(({ name, id, versions }) => [name, id, versions]), [['forge-std', 'GHSA-aaaa-aaaa-aaaa', ['1.9.2']]])
    assert.deepEqual(calls, [listing('acme/fork')])
  })

  it('takes a version semver cannot read, a bare number or a commit, as every version', async () => {
    stubUrls(Object.fromEntries([
      project('lib', 'https://github.com/acme/lib'),
      [listing('acme/lib'), [advisory('GHSA-aaaa-aaaa-aaaa', [vuln('lib', '>= 1.0.0, < 1.2.0')]), advisory('GHSA-bbbb-bbbb-bbbb', [vuln('lib', '>= 3.0.0')])]],
    ]))
    const commit = '1d9650e951204a0ddce9ff89c32f1997984cef4d'
    const found = await advisories([{ ecosystem: 'soldeer', name: 'lib', versions: ['1.1.0', '1.2.0', 'v1.1.5', '1.0.2-solc-0.8-simulate', '2', commit] }], { github })
    assert.deepEqual(found.map(({ id, versions }) => [id, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', ['1.0.2-solc-0.8-simulate', '1.1.0', commit, '2', 'v1.1.5']],
      ['GHSA-bbbb-bbbb-bbbb', [commit, '2']],
    ])
  })

  it('refuses a malformed name or version, or no GitHub client, before any request', async () => {
    const calls = stubUrls({})
    for (const name of ['ab', 'Forge-std', 'forge-std-', '../x', 'a/b', undefined]) {
      await assert.rejects(soldeer([{ name, version: '1.0.0' }]), /advisories: package\.name must be a Soldeer package name/u, String(name))
    }
    for (const version of ['', '-1', '1.0.0/x', '1 0', ['1.0.0'], undefined]) {
      await assert.rejects(soldeer([{ name: 'forge-std', version }]), /advisories: package\.versions must be letters, digits/u, String(version))
    }
    await assert.rejects(soldeer([{ name: 'forge-std', version: '1.9.2' }], {}), /advisories: soldeer packages need a github client/u)
    assert.deepEqual(calls, [])
  })

  it('throws when Soldeer fails, or answers malformed or about another project', async () => {
    const one = [{ name: 'forge-std', version: '1.9.2' }]
    for (const [answer, error] of [
      [Response.json({ status: 'fail' }, { status: 500 }), { name: 'HttpError', status: 500 }],
      [{ status: 'success' }, /advisories: expected a list of projects from Soldeer for forge-std/u],
      [{ data: {} }, /advisories: expected a list of projects from Soldeer for forge-std/u],
      [{ data: [{ name: 'forge', github_url: 'https://github.com/acme/forge' }] }, /advisories: Soldeer answered for "forge", not forge-std/u],
      [{ data: [null] }, /advisories: Soldeer answered for undefined, not forge-std/u],
    ]) {
      stubUrls({ [projectUrl('forge-std')]: answer })
      await assert.rejects(soldeer(one), error, JSON.stringify(answer))
    }
  })
})
