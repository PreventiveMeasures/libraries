import assert from 'node:assert/strict'

import { assertArgs, assertPackageName, assertPackageVersion, isGhsa, isStrings, optional, show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { lookUpPackageRepo } from '../npm/repos.js'
import { pool } from '../pool.js'
import { compareVersions, satisfies } from '../semver.js'
import { askedVersions, order } from './common.js'
import { assertClient, repositoryAdvisories } from './github.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const LOOKUPS_AT_ONCE = 8
const GHSA_PAGE = 'https://github.com/advisories/'

const isRow = (row) => row && typeof row === 'object' && Number.isSafeInteger(row.id)
  && ['url', 'title', 'severity', 'vulnerable_versions'].every((key) => typeof row[key] === 'string')
  && (row.cwe === undefined || isStrings(row.cwe))

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

async function registryAdvisories(asked) {
  const names = [...asked.keys()]
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

// What `npm audit` asks the registry, one row per vulnerable range, and
// with `github`, what the packages' repositories publish that the
// registry does not have yet.
export async function npmAdvisories(packages, options = {}) {
  const asked = askedVersions('npmAdvisories', packages, assertPackageName, assertPackageVersion, compareVersions)
  assertArgs('npmAdvisories', options, { github: optional(assertClient) })
  const advisories = await registryAdvisories(asked)
  if (options.github) {
    // The repository the registry names for a package, matched only for
    // that package, and never for an advisory the registry answered with.
    // A lookup that fails throws: it is not a package without one.
    const reported = new Set(advisories.map((advisory) => `${advisory.name} ${advisory.ghsa}`))
    const repos = await pool([...asked.keys()], LOOKUPS_AT_ONCE, async (name) => [name, await lookUpPackageRepo(name)])
    const namesOf = new Map()
    for (const [name, repo] of repos) if (repo) namesOf.set(repo.github, [...(namesOf.get(repo.github) ?? []), name])
    const takes = (name, pkg, advisory) => pkg?.ecosystem === 'npm' && pkg.name === name && !reported.has(`${name} ${advisory.ghsa_id}`)
    advisories.push(...await repositoryAdvisories('npmAdvisories', options.github, namesOf, asked, takes))
  }
  return advisories.filter((advisory) => advisory.versions.length > 0).toSorted((a, b) => order(a.name, b.name))
}
