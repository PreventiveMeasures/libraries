import assert from 'node:assert/strict'

import { assertPackageName, assertPackageVersion, isGhsa, show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { compareVersions, satisfies } from '../semver.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const GHSA_PAGE = 'https://github.com/advisories/'

const isRow = (row) => row && typeof row === 'object' && Number.isSafeInteger(row.id)
  && ['url', 'title', 'severity', 'vulnerable_versions'].every((key) => typeof row[key] === 'string')
  && (row.cwe === undefined || (Array.isArray(row.cwe) && row.cwe.every((cwe) => typeof cwe === 'string')))

function toAdvisory(name, row, asked) {
  const ghsa = row.url.startsWith(GHSA_PAGE) ? row.url.slice(GHSA_PAGE.length) : undefined
  const { score, vectorString } = row.cvss ?? {}
  return {
    name,
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

// What `npm audit` asks the registry: versions in, advisories out, one
// row per vulnerable range, and a name with none absent from the answer.
export async function npmAdvisories(packages) {
  assert.ok(typeof packages?.[Symbol.iterator] === 'function' && typeof packages !== 'string', 'npmAdvisories: packages must be an iterable of { name, version }')
  const versions = new Map()
  for (const pkg of packages) {
    assertPackageName('npmAdvisories', 'name', pkg?.name)
    assertPackageVersion('npmAdvisories', 'version', pkg.version)
    versions.set(pkg.name, (versions.get(pkg.name) ?? new Set()).add(pkg.version))
  }
  const names = [...versions.keys()].toSorted()
  const advisories = []
  for (let i = 0; i < names.length; i += NAMES_PER_REQUEST) {
    const chunk = names.slice(i, i + NAMES_PER_REQUEST)
    const body = Object.fromEntries(chunk.map((name) => [name, [...versions.get(name)].toSorted(compareVersions)]))
    const answer = await request(BULK_URL, { method: 'POST', body, as: 'json' })
    assert.ok(answer && typeof answer === 'object' && !Array.isArray(answer), 'npmAdvisories: expected an object from the registry')
    for (const name of Object.keys(answer)) assert.ok(Object.hasOwn(body, name), `npmAdvisories: the registry answered for ${show(name)}, which was not asked`)
    for (const name of chunk) {
      const rows = Object.hasOwn(answer, name) ? answer[name] : []
      assert.ok(Array.isArray(rows) && rows.every(isRow), `npmAdvisories: malformed advisories for ${name}`)
      advisories.push(...rows.map((row) => toAdvisory(name, row, body[name])).filter((advisory) => advisory.versions.length > 0))
    }
  }
  return advisories
}
