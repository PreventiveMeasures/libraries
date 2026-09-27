import assert from 'node:assert/strict'

import { assertArgs, assertPackageName, assertPackageVersion, assertion, isGhsa, optional, show } from '../args.js'
import { HttpError, NPM_REGISTRY, buildUrl, request } from '../http.js'
import { resolvePackageRepos } from '../npm/repos.js'
import { pool } from '../pool.js'
import { compareVersions, satisfies, validRange } from '../semver.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const REPOS_AT_ONCE = 4
const GHSA_PAGE = 'https://github.com/advisories/'
const GONE = new Set([301, 404, 410, 451]) // A repository renamed, deleted or blocked.

const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
const isRow = (row) => row && typeof row === 'object' && Number.isSafeInteger(row.id)
  && ['url', 'title', 'severity', 'vulnerable_versions'].every((key) => typeof row[key] === 'string')
  && (row.cwe === undefined || isStrings(row.cwe))
const isRepoAdvisory = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa_id)
  && advisory.state === 'published' && typeof advisory.summary === 'string'
  && (advisory.vulnerabilities == null || Array.isArray(advisory.vulnerabilities)) && (advisory.cwe_ids == null || isStrings(advisory.cwe_ids))
const assertClient = assertion('a GitHub client from createClient', (value) => typeof value?.listRepoAdvisories === 'function')

function fromRegistry(name, row, asked) {
  const ghsa = row.url.startsWith(GHSA_PAGE) ? row.url.slice(GHSA_PAGE.length) : undefined
  const { score, vectorString } = row.cvss ?? {}
  return {
    name,
    source: 'registry',
    id: row.id,
    ...(isGhsa(ghsa) && { ghsa }),
    title: row.title,
    severity: row.severity,
    ...(typeof score === 'number' && score > 0 && { cvss: score }), // npm spells "not scored" as 0.
    ...(typeof vectorString === 'string' && { cvssVector: vectorString }),
    cwe: row.cwe ?? [],
    range: row.vulnerable_versions,
    versions: asked.filter((version) => satisfies(version, row.vulnerable_versions)),
  }
}

// GitHub's `>= 1.0.0, < 1.2.6` is npm's with the commas dropped. A range
// semver cannot read covers every version: maintainers write these
// unreviewed, and a missed advisory is worse than a spare one.
function fromRepository(name, advisory, range, asked) {
  const npmRange = (range ?? '').replaceAll(',', ' ')
  const readable = validRange(npmRange) !== null
  const cvss = [advisory.cvss_severities?.cvss_v3, advisory.cvss_severities?.cvss_v4, advisory.cvss].find((entry) => typeof entry?.vector_string === 'string')
  const { severity } = advisory
  return {
    name,
    source: 'repository',
    ghsa: advisory.ghsa_id,
    title: advisory.summary,
    ...(typeof severity === 'string' && { severity: severity === 'medium' ? 'moderate' : severity }),
    ...(typeof cvss?.score === 'number' && cvss.score > 0 && { cvss: cvss.score }),
    ...(cvss && { cvssVector: cvss.vector_string }),
    cwe: advisory.cwe_ids ?? [],
    range: range ?? '',
    versions: asked.filter((version) => !readable || satisfies(version, npmRange)),
  }
}

async function registryAdvisories(asked) {
  const names = [...asked.keys()].toSorted()
  const advisories = []
  for (let i = 0; i < names.length; i += NAMES_PER_REQUEST) {
    const chunk = names.slice(i, i + NAMES_PER_REQUEST)
    const body = Object.fromEntries(chunk.map((name) => [name, asked.get(name)]))
    const answer = await request(BULK_URL, { method: 'POST', body, as: 'json' })
    assert.ok(answer && typeof answer === 'object' && !Array.isArray(answer), 'npmAdvisories: expected an object from the registry')
    for (const name of Object.keys(answer)) assert.ok(Object.hasOwn(body, name), `npmAdvisories: the registry answered for ${show(name)}, which was not asked`)
    for (const name of chunk) {
      const rows = Object.hasOwn(answer, name) ? answer[name] : []
      assert.ok(Array.isArray(rows) && rows.every(isRow), `npmAdvisories: malformed advisories for ${name}`)
      advisories.push(...rows.map((row) => fromRegistry(name, row, asked.get(name))))
    }
  }
  return advisories
}

// A maintainer's advisory is on the repository before GitHub reviews it
// into the database the registry answers from. Only the packages the
// registry names that repository for are matched against it.
async function repositoryAdvisories(github, asked, reported) {
  const packagesOf = new Map()
  for (const [name, { github: repo }] of await resolvePackageRepos(asked.keys())) packagesOf.set(repo, [...(packagesOf.get(repo) ?? []), name])
  const repos = [...packagesOf.keys()]
  const lists = await pool(repos, REPOS_AT_ONCE, (repo) => github.listRepoAdvisories({ repo }).catch((err) => {
    if (err instanceof HttpError && GONE.has(err.status)) return []
    throw err
  }))
  const advisories = []
  for (const [k, repo] of repos.entries()) {
    for (const advisory of lists[k]) {
      assert.ok(isRepoAdvisory(advisory), `npmAdvisories: malformed advisory from ${repo}`)
      if (advisory.withdrawn_at) continue
      for (const { package: pkg, vulnerable_version_range: range } of advisory.vulnerabilities ?? []) {
        const name = pkg?.name
        if (pkg?.ecosystem !== 'npm' || !packagesOf.get(repo).includes(name) || reported.has(`${name} ${advisory.ghsa_id}`)) continue
        assert.ok(range == null || typeof range === 'string', `npmAdvisories: malformed range in ${advisory.ghsa_id}`)
        advisories.push(fromRepository(name, advisory, range, asked.get(name)))
      }
    }
  }
  return advisories
}

// What `npm audit` asks the registry, one row per vulnerable range, and
// with `github`, what the packages' repositories publish that the
// registry does not have yet.
export async function npmAdvisories(packages, options = {}) {
  assert.ok(typeof packages?.[Symbol.iterator] === 'function' && typeof packages !== 'string', 'npmAdvisories: packages must be an iterable of { name, version }')
  assertArgs('npmAdvisories', options, { github: optional(assertClient) })
  const versions = new Map()
  for (const pkg of packages) {
    assertPackageName('npmAdvisories', 'name', pkg?.name)
    assertPackageVersion('npmAdvisories', 'version', pkg.version)
    versions.set(pkg.name, (versions.get(pkg.name) ?? new Set()).add(pkg.version))
  }
  const asked = new Map([...versions].map(([name, set]) => [name, [...set].toSorted(compareVersions)]))
  const advisories = await registryAdvisories(asked)
  if (options.github) {
    const reported = new Set(advisories.map((advisory) => `${advisory.name} ${advisory.ghsa}`))
    advisories.push(...await repositoryAdvisories(options.github, asked, reported))
  }
  return advisories.filter((advisory) => advisory.versions.length > 0).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
