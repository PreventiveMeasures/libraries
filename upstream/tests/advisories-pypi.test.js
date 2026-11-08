import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { mapStore } from './cache-store.js'

const BATCH = 'https://api.osv.dev/v1/querybatch'
const VULN = 'https://api.osv.dev/v1/vulns/'
const PYPI = 'https://pypi.org/pypi/'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
const pkg = (name, versions, rest = {}) => ({ ecosystem: 'pypi', name, versions, ...rest })

// OSV, PyPI and GitHub, each answering from what is given: `hits` is
// `name@version` -> ids, `records` id -> record, `projects` `name/version`
// -> PyPI's `info` for it (a Response as is), and `listings` repo -> its
// listing. `calls` is every request, with its parsed body.
function stubAll({ hits = {}, records = {}, projects = {}, listings = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    const body = init.body && JSON.parse(init.body)
    calls.push({ url, body })
    if (url === BATCH) {
      return Promise.resolve(Response.json({ results: body.queries.map(({ package: { name }, version }) => ({ vulns: (hits[`${name}@${version}`] ?? []).map((id) => ({ id })) })) }))
    }
    if (url.startsWith(VULN)) return Promise.resolve(Response.json(records[url.slice(VULN.length)]))
    if (url.startsWith(PYPI)) {
      const key = decodeURIComponent(url.slice(PYPI.length, -'/json'.length))
      const answer = projects[key]
      if (answer instanceof Response) return Promise.resolve(answer.clone())
      return Promise.resolve(answer ? Response.json({ info: { name: key.split('/')[0], ...answer }, urls: [] }) : Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    const listed = Object.entries(listings).find(([repo]) => url === listing(repo))
    if (listed) return Promise.resolve(Response.json(listed[1]))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// As OSV has GitHub's record of Django's GHSA-qrw5-5h28-6cmg, and PyPA's.
const ghsa = (id, overrides = {}) => ({
  id,
  summary: `Advisory ${id}`,
  aliases: ['CVE-2024-27351', 'PYSEC-2024-47'],
  database_specific: { severity: 'MODERATE', github_reviewed: true, cwe_ids: ['CWE-1333'] },
  affected: [{ package: { name: 'django', ecosystem: 'PyPI', purl: 'pkg:pypi/django' } }],
  ...overrides,
})
const pysec = (id, aliases) => ({ id, aliases, affected: [{ package: { name: 'django', ecosystem: 'PyPI' } }] })
const repoAdvisory = (id, vulnerabilities) => ({ ghsa_id: id, state: 'published', summary: `Advisory ${id}`, severity: 'high', vulnerabilities })
const vuln = (name, range, patched, ecosystem = 'pip') => ({ package: { ecosystem, name }, vulnerable_version_range: range, ...(patched !== undefined && { patched_versions: patched }) })

describe('pypi', () => {
  it('asks OSV of PyPI for each version, as PEP 440 orders them, a name spelled two ways as one, and answers its records', async () => {
    const calls = stubAll({
      hits: { 'Django@4.2': ['GHSA-qrw5-5h28-6cmg', 'PYSEC-2024-47'], 'Django@4.2.0': ['GHSA-qrw5-5h28-6cmg', 'PYSEC-2024-47'], 'Django@4.2rc1': ['PYSEC-2024-47'] },
      records: { 'GHSA-qrw5-5h28-6cmg': ghsa('GHSA-qrw5-5h28-6cmg'), 'PYSEC-2024-47': pysec('PYSEC-2024-47', ['CVE-2024-27351', 'GHSA-qrw5-5h28-6cmg']) },
    })
    const found = await advisories([pkg('Django', ['4.2.11', '4.2.0', '4.2rc1', '4.2.dev1']), pkg('django', ['4.2']), pkg('typing_extensions', ['4.0.0'])])
    assert.deepEqual(calls[0].body.queries.map(({ package: { name, ecosystem }, version }) => `${ecosystem} ${name}@${version}`), [
      // A dev release is below a pre-release, which is below its release;
      // 4.2 and 4.2.0 are one version, by their text.
      'PyPI Django@4.2.dev1', 'PyPI Django@4.2rc1', 'PyPI Django@4.2', 'PyPI Django@4.2.0', 'PyPI Django@4.2.11',
      'PyPI typing_extensions@4.0.0',
    ])
    assert.deepEqual(found.map(({ ecosystem, name, source, id, url, aliases, severity, versions }) => [ecosystem, name, source, id, url, aliases, severity, versions]), [
      // The GHSA stands for PyPA's record where both report a version.
      ['pypi', 'Django', 'osv', 'GHSA-qrw5-5h28-6cmg', 'https://github.com/advisories/GHSA-qrw5-5h28-6cmg', ['CVE-2024-27351', 'PYSEC-2024-47'], 'moderate', ['4.2', '4.2.0']],
      // PyPA's beyond it, linked to its one GHSA's page.
      ['pypi', 'Django', 'osv', 'PYSEC-2024-47', 'https://github.com/advisories/GHSA-qrw5-5h28-6cmg', ['CVE-2024-27351', 'GHSA-qrw5-5h28-6cmg'], undefined, ['4.2rc1']],
    ])
  })

  it('refuses a malformed name or version before any request', async () => {
    const calls = stubAll()
    for (const version of ['1.0-final', '1.', '1..0', '1.0.*', ' 1.0', '1.0 ', '', '>=1.0', 'v', '1'.repeat(257), undefined]) {
      await assert.rejects(advisories([pkg('django', [version])]), /advisories: package\.versions must be a PEP 440 version/u, String(version))
    }
    for (const name of ['', '-django', 'django-', '.x', 'dj ango', 'a/b', 'café', 'x'.repeat(256), undefined]) {
      await assert.rejects(advisories([pkg(name, ['1.0'])]), /advisories: package\.name must be a Python package name/u, String(name))
    }
    for (const version of ['1.0', 'v1.0', '1!2.0', '1.0.post1.dev2', '1.13.0+cpu', '2.0-RC.1', '20260722']) assert.deepEqual(await advisories([pkg('django', [version])]), [], version)
    assert.equal(calls.length, 7)
  })
})

describe('pypi, with a GitHub client', () => {
  const options = { github, repoAdvisories: true }

  it("adds what the package's repository publishes, its ranges read as PEP 440 orders versions, its name in any spelling", async () => {
    const calls = stubAll({
      projects: { 'Django/4.2.11': { project_urls: { Homepage: 'https://www.djangoproject.com/', Source: 'https://github.com/django/django' } } },
      listings: {
        'django/django': [
          // A pre-release is below its release, and 4.2 is 4.2.0.
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('django', '< 4.2')]),
          // PEP 503's spelling of the same name; a post-release is above.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('DJANGO', '>= 4.2.0, <= 4.2.11.post0')]),
          // Ended below its one patched version.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('django', '>= 4.2.10', '4.2.11')]),
          // One PEP 440 cannot read covers every version; another package's,
          // or another ecosystem's, none.
          repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('django', '~= 4.2'), vuln('django-filter', '< 99'), vuln('django', '< 99', undefined, 'npm')]),
        ],
      },
    })
    const found = await advisories([pkg('Django', ['4.2rc1', '4.2', '4.2.11'])], options)
    assert.deepEqual(found.map(({ source, id, url, range, versions }) => [source, id, url, range, versions]), [
      ['repository', 'GHSA-aaaa-aaaa-aaaa', 'https://github.com/django/django/security/advisories/GHSA-aaaa-aaaa-aaaa', '< 4.2', ['4.2rc1']],
      ['repository', 'GHSA-bbbb-bbbb-bbbb', 'https://github.com/django/django/security/advisories/GHSA-bbbb-bbbb-bbbb', '>= 4.2.0, <= 4.2.11.post0', ['4.2', '4.2.11']],
      ['repository', 'GHSA-dddd-dddd-dddd', 'https://github.com/django/django/security/advisories/GHSA-dddd-dddd-dddd', '~= 4.2', ['4.2rc1', '4.2', '4.2.11']],
    ])
    // The newest version asked is looked up, as PyPI has it for that version alone.
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(PYPI)).map(({ url }) => url), [`${PYPI}Django/4.2.11/json`])
  })

  it("takes a link of the project's source first, then its homepage, home_page, then any other in a repository's tree; none, or no such version, asks no repository", async () => {
    const calls = stubAll({
      projects: {
        'requests/2.31.0': { project_urls: { Documentation: 'https://requests.readthedocs.io', 'Source Code': 'https://github.com/psf/requests' }, home_page: 'https://github.com/other/home' },
        'flask/3.0.0': { project_urls: { 'Home-Page': 'https://github.com/pallets/flask/' } },
        'attrs/23.1.0': { project_urls: null, home_page: 'https://github.com/python-attrs/attrs' },
        'boto3/1.34.0': { project_urls: { Documentation: 'https://boto3.readthedocs.io', Changelog: 'https://github.com/boto/boto3/blob/develop/CHANGELOG.rst' } },
        'numpy/1.26.0': { project_urls: { Homepage: 'https://numpy.org', 'Bug Tracker': 'https://github.com/numpy/numpy/issues' } },
      },
      listings: { 'psf/requests': [], 'pallets/flask': [], 'python-attrs/attrs': [], 'boto/boto3': [] },
    })
    const asked = [['attrs', '23.1.0'], ['boto3', '1.34.0'], ['flask', '3.0.0'], ['gone', '1.0'], ['numpy', '1.26.0'], ['requests', '2.31.0']]
    assert.deepEqual(await advisories(asked.map(([name, version]) => pkg(name, [version])), options), [])
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(PYPI)).map(({ url }) => url), asked.map(([name, version]) => `${PYPI}${name}/${version}/json`))
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('https://api.github.com/')).map(({ url }) => url).toSorted(), [
      listing('boto/boto3'), listing('pallets/flask'), listing('psf/requests'), listing('python-attrs/attrs'),
    ])
  })

  it('throws where PyPI fails, or answers for another package', async () => {
    stubAll({ projects: { 'django/4.2': Response.json({}, { status: 500 }) } })
    await assert.rejects(advisories([pkg('django', ['4.2'])], options), { name: 'HttpError', status: 500 })
    stubAll({ projects: { 'django/4.2': Response.json({ info: { name: 'flask' } }) } })
    await assert.rejects(advisories([pkg('django', ['4.2'])], options), /advisories: PyPI answered for "flask", not django/u)
  })

  it("keeps a package's repository a month in a caller's store, and none it did not find", async () => {
    const store = mapStore()
    const answers = { projects: { 'django/4.2': { project_urls: { Source: 'https://github.com/django/django' } }, 'local/1.0': {} }, listings: { 'django/django': [] } }
    stubAll(answers)
    const packages = [pkg('django', ['4.2']), pkg('local', ['1.0'])]
    await advisories(packages, { ...options, cache: store })
    assert.deepEqual(store.log.filter(([op, type]) => op === 'write' && type === 'pypi/repos').map(([, , key]) => key), ['django'])
    const calls = stubAll(answers)
    await advisories(packages, { ...options, cache: store })
    assert.deepEqual(calls.filter(({ url }) => url.startsWith(PYPI)).map(({ url }) => url), [`${PYPI}local/1.0/json`])
  })
})
