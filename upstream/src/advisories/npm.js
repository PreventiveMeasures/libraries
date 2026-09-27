import assert from 'node:assert/strict'

import { assertPackageName, assertPackageVersion, isGhsa, isStrings, show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'
import { compareVersions } from '../semver.js'
import { covered, isText, metrics } from './common.js'
import { withRepositories } from './github.js'
import { npmRepos } from './repos.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const GHSA_PAGE = 'https://github.com/advisories/'

const isRow = (row) => row && typeof row === 'object' && Number.isSafeInteger(row.id)
  && ['url', 'severity', 'vulnerable_versions'].every((key) => typeof row[key] === 'string') && isText(row.title)
  && (row.cwe === undefined || isStrings(row.cwe))

function fromRegistry(name, row, asked) {
  const ghsa = row.url.startsWith(GHSA_PAGE) ? row.url.slice(GHSA_PAGE.length) : undefined
  return {
    name,
    source: 'registry',
    id: isGhsa(ghsa) ? ghsa : `npm:${row.id}`,
    ...(isGhsa(ghsa) && { ghsa }),
    aliases: [],
    title: row.title,
    ...metrics({ severity: row.severity, score: row.cvss?.score, vector: row.cvss?.vectorString, cwe: row.cwe }),
    range: row.vulnerable_versions,
    versions: covered(asked, row.vulnerable_versions),
  }
}

async function registryAdvisories(asked) {
  const names = [...asked.keys()]
  const advisories = []
  for (let i = 0; i < names.length; i += NAMES_PER_REQUEST) {
    const chunk = names.slice(i, i + NAMES_PER_REQUEST)
    const body = Object.fromEntries(chunk.map((name) => [name, asked.get(name)]))
    const answer = await request(BULK_URL, { method: 'POST', body, as: 'json' })
    assert.ok(answer && typeof answer === 'object' && !Array.isArray(answer), 'advisories: expected an object from the registry')
    for (const name of Object.keys(answer)) assert.ok(Object.hasOwn(body, name), `advisories: the registry answered for ${show(name)}, which was not asked`)
    for (const name of chunk) {
      const rows = Object.hasOwn(answer, name) ? answer[name] : []
      assert.ok(Array.isArray(rows) && rows.every(isRow), `advisories: malformed advisories for ${name}`)
      advisories.push(...rows.map((row) => fromRegistry(name, row, asked.get(name))))
    }
  }
  return advisories
}

// What `npm audit` asks the registry, one row per vulnerable range.
export const NPM = {
  assertName: assertPackageName,
  assertVersion: assertPackageVersion,
  compare: compareVersions,
  advisories: async (asked, options) => await withRepositories(await registryAdvisories(asked), asked, options, { ecosystem: 'npm', lookUp: npmRepos }),
}
