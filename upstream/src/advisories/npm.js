import assert from 'node:assert/strict'

import { assertPackageName, assertPackageVersion, isGhsa, isStrings, show } from '../args.js'
import { NPM_REGISTRY, buildUrl, isNotFound, recover, request } from '../http.js'
import { chunks, pool } from '../pool.js'
import { compareVersions } from '../semver.js'
import { advisoryUrl, covered, detailsOf, isText, metrics } from './common.js'
import { withRepositories } from './github.js'
import { RECORDS_AT_ONCE, getVuln } from './osv.js'
import { npmRepos } from './repos.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const GHSA_PAGE = 'https://github.com/advisories/'

const isRow = (row) => row && typeof row === 'object' && Number.isSafeInteger(row.id)
  && ['url', 'severity', 'vulnerable_versions'].every((key) => typeof row[key] === 'string') && isText(row.title)
  && (row.cwe === undefined || isStrings(row.cwe))

function fromRegistry(name, row, asked) {
  const tail = row.url.startsWith(GHSA_PAGE) ? row.url.slice(GHSA_PAGE.length) : ''
  const ghsa = isGhsa(tail) ? tail : undefined
  return {
    name,
    source: 'registry',
    id: ghsa ?? `npm:${row.id}`,
    ...(ghsa && { ghsa, url: advisoryUrl(ghsa) }),
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
  for (const chunk of chunks(names, NAMES_PER_REQUEST)) {
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

// The registry's rows carry no text: each GHSA's is OSV's record of it,
// GitHub's advisory database as published, asked once for the rows that
// cover an asked version. One OSV does not have yet has none.
async function withDetails(rows) {
  const ghsas = [...new Set(rows.filter((row) => row.ghsa && row.versions.length > 0).map((row) => row.ghsa))]
  const records = await pool(ghsas, RECORDS_AT_ONCE, (ghsa) => getVuln(ghsa).catch(recover(isNotFound, undefined)))
  const text = new Map(ghsas.map((ghsa, i) => [ghsa, records[i]?.details]))
  return rows.map((row) => ({ ...row, ...detailsOf(text.get(row.ghsa), row.ghsa) }))
}

// What `npm audit` asks the registry, one row per vulnerable range.
export const NPM = {
  assertName: assertPackageName,
  assertVersion: assertPackageVersion,
  compare: compareVersions,
  advisories: async (asked, options) => {
    const rows = await registryAdvisories(asked)
    return await withRepositories(options.details ? await withDetails(rows) : rows, asked, options, { ecosystem: 'npm', lookUp: npmRepos })
  },
}
