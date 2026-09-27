import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError, githubAdvisories, npmAdvisories } from '../advisories.js'
import { createClient } from '../github.js'

const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

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

describe('npmAdvisories', () => {
  it('answers one entry per package and range, with the asked versions it covers', async () => {
    const calls = stubRegistry(() => ({
      minimist: [row({ id: 1, vulnerable_versions: '<0.2.4' }), row({ id: 2 })],
      lodash: [row({ id: 3, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', vulnerable_versions: '<4.17.21', cwe: undefined, cvss: { score: 0, vectorString: null } })],
    }))
    const advisories = await npmAdvisories([
      { name: 'minimist', version: '1.2.0' },
      { name: 'lodash', version: '4.17.21' },
      { name: 'lodash', version: '4.17.15' },
      { name: 'minimist', version: '1.2.0' },
    ])
    assert.deepEqual(calls, [{ url: BULK, method: 'POST', body: { lodash: ['4.17.15', '4.17.21'], minimist: ['1.2.0'] } }])
    assert.deepEqual(advisories, [
      { name: 'lodash', source: 'registry', id: 3, ghsa: 'GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', cwe: [], range: '<4.17.21', versions: ['4.17.15'] },
      { name: 'minimist', source: 'registry', id: 2, ghsa: 'GHSA-xvch-5gv4-984h', title: 'Prototype Pollution in minimist', severity: 'critical', cvss: 9.8, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe: ['CWE-1321'], range: '>=1.0.0 <1.2.6', versions: ['1.2.0'] },
    ])
  })

  it('takes a GHSA only from a GitHub advisory page', async () => {
    stubRegistry(() => ({
      pkg: [
        row({ id: 1, url: 'https://npmjs.com/advisories/1' }),
        row({ id: 2, url: 'https://evil.example/advisories/GHSA-xvch-5gv4-984h' }),
        row({ id: 3, url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h/x' }),
      ],
    }))
    const advisories = await npmAdvisories([{ name: 'pkg', version: '1.0.0' }])
    assert.deepEqual(advisories.map((advisory) => [advisory.id, advisory.ghsa]), [[1, undefined], [2, undefined], [3, undefined]])
  })

  it('asks for 250 names at a time, in name order', async () => {
    const calls = stubRegistry(() => ({}))
    const names = Array.from({ length: 251 }, (_, i) => `pkg-${String(i).padStart(3, '0')}`)
    assert.deepEqual(await npmAdvisories(names.toReversed().map((name) => ({ name, version: '1.0.0' }))), [])
    assert.deepEqual(calls.map((call) => Object.keys(call.body)), [names.slice(0, 250), names.slice(250)])
  })

  it('makes no request for no packages', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    assert.deepEqual(await npmAdvisories([]), [])
    assert.deepEqual(calls, [])
  })

  it('refuses a malformed name or version, or anything but an iterable, before any request', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    for (const packages of ['lodash', undefined, { name: 'lodash', version: '1.0.0' }]) {
      await assert.rejects(npmAdvisories(packages), /npmAdvisories: packages must be an iterable/u, String(packages))
    }
    for (const pkg of [null, { name: '../x', version: '1.0.0' }, { name: ['lodash'], version: '1.0.0' }, { version: '1.0.0' }]) {
      await assert.rejects(npmAdvisories([{ name: 'ok', version: '1.0.0' }, pkg]), /npmAdvisories: name must be an npm package name/u, JSON.stringify(pkg))
    }
    for (const version of ['^1.0.0', 'file:../x', '1.0.0+build', 'latest', undefined]) {
      await assert.rejects(npmAdvisories([{ name: 'lodash', version }]), /npmAdvisories: version must be an exact semver version/u, String(version))
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
      await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }]), error, JSON.stringify(answer))
    }
  })

  it('throws an HttpError for a failed request', async () => {
    globalThis.fetch = () => Promise.resolve(Response.json({ error: 'nope' }, { status: 503 }))
    await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }]), (err) => err instanceof HttpError && err.status === 503)
  })
})

describe('npmAdvisories with a GitHub client', () => {
  const REPO_ADVISORIES = 'https://api.github.com/repos/acme/mono/security-advisories?state=published&per_page=100'
  const github = createClient({ token: 'test-token' })
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
  const vuln = (name, range, ecosystem = 'npm') => ({ package: { ecosystem, name }, vulnerable_version_range: range, patched_versions: null })

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
      bulk: { 'mono-a': [row({ id: 7, url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', vulnerable_versions: '<0.1.0' })] },
      repos: { 'mono-a': 'acme/mono', 'mono-b': 'acme/mono' },
      github: {
        [REPO_ADVISORIES]: [
          // Reviewed, and the registry's range misses 1.0.0: the registry's word stands.
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('mono-a', '< 2.0.0')]),
          // Two disjoint ranges are two entries, and two rows.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('mono-a', '>= 1.0.0, < 1.2.6'), vuln('mono-a', '>= 2.0.0, < 2.1.0'), vuln('mono-a', '>= 3.0.0')]),
          // Another package in the repo, one not asked, another ecosystem.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('mono-b', 'not a range'), vuln('mono-c', '< 9.0.0'), vuln('mono-a', '< 9.0.0', 'pip')], { severity: null, cvss_severities: null, cwe_ids: null }),
          repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('mono-a', '< 9.0.0')], { withdrawn_at: '2026-01-01T00:00:00Z' }),
        ],
      },
    })
    const advisories = await npmAdvisories([
      { name: 'mono-a', version: '1.0.0' },
      { name: 'mono-a', version: '2.0.5' },
      { name: 'mono-b', version: '4.0.0' },
    ], { github })
    assert.deepEqual(advisories, [
      {
        name: 'mono-a', source: 'repository', ghsa: 'GHSA-bbbb-bbbb-bbbb', title: 'Advisory GHSA-bbbb-bbbb-bbbb', severity: 'moderate', cvss: 6.1,
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe: ['CWE-79'], range: '>= 1.0.0, < 1.2.6', versions: ['1.0.0'],
      },
      {
        name: 'mono-a', source: 'repository', ghsa: 'GHSA-bbbb-bbbb-bbbb', title: 'Advisory GHSA-bbbb-bbbb-bbbb', severity: 'moderate', cvss: 6.1,
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe: ['CWE-79'], range: '>= 2.0.0, < 2.1.0', versions: ['2.0.5'],
      },
      { name: 'mono-b', source: 'repository', ghsa: 'GHSA-cccc-cccc-cccc', title: 'Advisory GHSA-cccc-cccc-cccc', cwe: [], range: 'not a range', versions: ['4.0.0'] },
    ])
  })

  it('asks GitHub once per repository, and not for a package with no repo', async () => {
    const calls = stubAll({ repos: { 'mono-a': 'acme/mono', 'mono-b': 'acme/mono' }, github: { [REPO_ADVISORIES]: [] } })
    assert.deepEqual(await npmAdvisories([{ name: 'mono-a', version: '1.0.0' }, { name: 'mono-b', version: '1.0.0' }, { name: 'norepo', version: '1.0.0' }], { github }), [])
    assert.deepEqual(calls.filter((url) => url.startsWith('https://api.github.com/')), [REPO_ADVISORIES])
  })

  it('skips a repository gone, renamed or blocked, and throws on any other failure', async () => {
    const one = [{ name: 'mono-a', version: '1.0.0' }]
    for (const status of [301, 404, 410, 451]) {
      const answer = status === 301 ? new Response('', { status, headers: { location: 'https://api.github.com/repositories/1' } }) : Response.json({ message: 'x' }, { status })
      stubAll({ repos: { 'mono-a': 'acme/mono' }, github: { [REPO_ADVISORIES]: answer } })
      assert.deepEqual(await npmAdvisories(one, { github }), [], String(status))
    }
    for (const status of [403, 500]) {
      stubAll({ repos: { 'mono-a': 'acme/mono' }, github: { [REPO_ADVISORIES]: Response.json({ message: 'x' }, { status }) } })
      await assert.rejects(npmAdvisories(one, { github }), (err) => err instanceof HttpError && err.status === status, String(status))
    }
    stubAll({ repos: { 'mono-a': 'acme/mono' }, github: { [REPO_ADVISORIES]: [{ ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'draft', summary: 'x' }] } })
    await assert.rejects(npmAdvisories(one, { github }), /npmAdvisories: malformed advisory from acme\/mono/u)
    stubAll({ repos: { 'mono-a': 'acme/mono' }, github: { [REPO_ADVISORIES]: Array.from({ length: 100 }, (_, i) => repoAdvisory(`GHSA-aaaa-aaaa-${String(i).padStart(4, '2')}`, [])) } })
    await assert.rejects(npmAdvisories(one, { github }), /listRepoAdvisories: acme\/mono has 100 or more published advisories/u)
  })

  it('throws when a package\'s repository cannot be looked up, and skips one the registry does not have', async () => {
    const one = [{ name: 'mono-a', version: '1.0.0' }]
    stubAll({ repos: {} })
    assert.deepEqual(await npmAdvisories(one, { github }), [])
    for (const status of [429, 500]) {
      const calls = []
      globalThis.fetch = (url) => {
        calls.push(String(url))
        return Promise.resolve(String(url) === BULK ? Response.json({}) : Response.json({ error: 'x' }, { status }))
      }
      await assert.rejects(npmAdvisories(one, { github }), (err) => err instanceof HttpError && err.status === status, String(status))
      assert.deepEqual(calls, [BULK, 'https://registry.npmjs.org/mono-a/latest'])
    }
    globalThis.fetch = (url) => Promise.resolve(String(url) === BULK ? Response.json({}) : Response.json({ name: 'other' }))
    await assert.rejects(npmAdvisories(one, { github }), /lookUpPackageRepo: the registry answered for "other", not mono-a/u)
  })

  it('refuses a github option that is not a client, before any request', async () => {
    const calls = stubAll({})
    for (const option of [{}, 'token', { listRepoAdvisories: 1 }]) {
      await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }], { github: option }), /npmAdvisories: github must be a GitHub client from createClient/u)
    }
    await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }], { gitHub: github }), /npmAdvisories: unknown option gitHub/u)
    assert.deepEqual(calls, [])
  })
})

describe('githubAdvisories', () => {
  const OZ = 'https://api.github.com/repos/OpenZeppelin/openzeppelin-contracts/security-advisories?state=published&per_page=100'
  const github = createClient({ token: 'test-token' })
  const advisory = (ghsa, vulnerabilities, overrides = {}) => ({ ghsa_id: ghsa, state: 'published', summary: `Advisory ${ghsa}`, severity: 'high', cwe_ids: [], vulnerabilities, ...overrides })
  const vuln = (name, range) => ({ package: { ecosystem: 'npm', name }, vulnerable_version_range: range })

  function stubGitHub(answers) {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      const answer = answers[String(url)]
      if (answer === undefined) return Promise.reject(new Error(`unexpected request: ${url}`))
      return Promise.resolve(answer instanceof Response ? answer.clone() : Response.json(answer))
    }
    return calls
  }

  it("counts every range a repository's advisories list, whichever package, once each", async () => {
    const calls = stubGitHub({
      [OZ]: [
        advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3'), vuln('@openzeppelin/contracts-upgradeable', '>= 4.0.0, < 4.9.3')]),
        advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '>= 5.0.0, < 5.0.2'), { package: { ecosystem: 'other', name: 'x' }, vulnerable_version_range: null }]),
        advisory('GHSA-cccc-cccc-cccc', [vuln('@openzeppelin/contracts', '< 9.0.0')], { withdrawn_at: '2026-01-01T00:00:00Z' }),
      ],
    })
    const advisories = await githubAdvisories([
      { name: 'OpenZeppelin/openzeppelin-contracts', version: '4.9.0' },
      { name: 'OpenZeppelin/openzeppelin-contracts', version: '5.0.1' },
    ], { github })
    assert.deepEqual(calls, [OZ])
    assert.deepEqual(advisories.map(({ ghsa, range, versions }) => [ghsa, range, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', '>= 4.0.0, < 4.9.3', ['4.9.0']],
      ['GHSA-bbbb-bbbb-bbbb', '>= 5.0.0, < 5.0.2', ['5.0.1']],
      ['GHSA-bbbb-bbbb-bbbb', '', ['4.9.0', '5.0.1']],
    ])
    assert.deepEqual(advisories[0], {
      name: 'OpenZeppelin/openzeppelin-contracts', source: 'repository', ghsa: 'GHSA-aaaa-aaaa-aaaa', title: 'Advisory GHSA-aaaa-aaaa-aaaa', severity: 'high', cwe: [], range: '>= 4.0.0, < 4.9.3', versions: ['4.9.0'],
    })
  })

  it('takes a branch name or 0.0.0 as every version', async () => {
    stubGitHub({
      [OZ]: [
        advisory('GHSA-aaaa-aaaa-aaaa', [vuln('@openzeppelin/contracts', '>= 4.0.0, < 4.9.3')]),
        advisory('GHSA-bbbb-bbbb-bbbb', [vuln('@openzeppelin/contracts', '= 5.0.1')]),
      ],
    })
    const advisories = await githubAdvisories(['master', '0.0.0', 'v4.9.0', '5.0.1', '6.0.0'].map((version) => ({ name: 'OpenZeppelin/openzeppelin-contracts', version })), { github })
    assert.deepEqual(advisories.map(({ ghsa, versions }) => [ghsa, versions]), [
      ['GHSA-aaaa-aaaa-aaaa', ['0.0.0', 'master', 'v4.9.0']],
      ['GHSA-bbbb-bbbb-bbbb', ['0.0.0', '5.0.1', 'master', 'v4.9.0']],
    ])
  })

  it('skips a repository gone, and throws on any other failure', async () => {
    const one = [{ name: 'OpenZeppelin/openzeppelin-contracts', version: '4.9.0' }]
    stubGitHub({ [OZ]: Response.json({ message: 'Not Found' }, { status: 404 }) })
    assert.deepEqual(await githubAdvisories(one, { github }), [])
    stubGitHub({ [OZ]: Response.json({ message: 'rate limited' }, { status: 403 }) })
    await assert.rejects(githubAdvisories(one, { github }), { name: 'HttpError', status: 403 })
    stubGitHub({ [OZ]: [advisory('GHSA-aaaa-aaaa-aaaa', [{ package: null, vulnerable_version_range: 42 }])] })
    await assert.rejects(githubAdvisories(one, { github }), /githubAdvisories: malformed range in GHSA-aaaa-aaaa-aaaa/u)
  })

  it('refuses what is not `owner/name` at a version or branch, or no client, before any request', async () => {
    const calls = stubGitHub({})
    for (const name of ['openzeppelin-contracts', 'a/b/c', '../x', undefined]) {
      await assert.rejects(githubAdvisories([{ name, version: '1.0.0' }], { github }), /githubAdvisories: name must be "owner\/name"/u, String(name))
    }
    for (const version of ['', 'a b', 'x..y', 'main.lock', '-x', ['main'], undefined]) {
      await assert.rejects(githubAdvisories([{ name: 'acme/app', version }], { github }), /githubAdvisories: version must be a version or a branch name/u, String(version))
    }
    await assert.rejects(githubAdvisories([{ name: 'acme/app', version: '1.0.0' }]), /githubAdvisories: options must be an options object/u)
    await assert.rejects(githubAdvisories([{ name: 'acme/app', version: '1.0.0' }], {}), /githubAdvisories: github must be a GitHub client/u)
    assert.deepEqual(calls, [])
  })
})
