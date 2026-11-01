import assert from 'node:assert/strict'

import { assertPackageName, assertPackageVersion, isGhsa, isStrings, show } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { NPM_REGISTRY, answersHead, buildUrl, isNotFound, recover, request } from '../http.js'
import { chunks, pool } from '../pool.js'
import { compareVersions } from '../semver.js'
import { advisoryUrl, covered, detailsOf, isText, metrics } from './common.js'
import { withRepositories } from './github.js'
import { RECORDS_AT_ONCE, getVuln, osvRows } from './osv.js'
import { npmRepos } from './repos.js'

const BULK_URL = buildUrl(NPM_REGISTRY, ['-', 'npm', 'v1', 'security', 'advisories', 'bulk'])
const NAMES_PER_REQUEST = 250
const GHSA_PAGE = 'https://github.com/advisories/'
const NAMES_AT_ONCE = 8

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
// cover an asked version, but where `osv` already read it. One OSV does
// not have yet has none.
async function withDetails(rows) {
  const asks = (row) => row.source === 'registry' && row.details === undefined
  const ghsas = [...new Set(rows.filter((row) => asks(row) && row.ghsa && row.versions.length > 0).map((row) => row.ghsa))]
  const records = await pool(ghsas, RECORDS_AT_ONCE, (ghsa) => getVuln(ghsa).catch(recover(isNotFound, undefined)))
  const text = new Map(ghsas.map((ghsa, i) => [ghsa, records[i]?.details]))
  return rows.map((row) => (asks(row) ? { ...row, ...detailsOf(text.get(row.ghsa), row.ghsa) } : row))
}

// With `osv`, OSV's records of the asked versions besides the registry's
// rows, the malicious packages' (MAL-...), which the registry has none
// of, among them. A version a registry row reports under the same
// advisory, the row's id one of an OSV row's ids or aliases, is left to
// that row, which takes the OSV row's ids among its aliases, and its text
// where it is the same record; an OSV row keeps the versions no such row
// reports, which advisories() joins to a registry row of its own id.
function withOsv(registry, osv) {
  const rows = registry.map((row) => ({ ...row }))
  const added = []
  for (const record of osv) {
    const ids = [record.id, ...record.aliases]
    const same = rows.filter((row) => row.name === record.name && ids.includes(row.id) && row.versions.some((version) => record.versions.includes(version)))
    for (const row of same) {
      row.aliases = [...new Set([...row.aliases, ...ids])].filter((id) => id !== row.id)
      if (record.id === row.id && record.details !== undefined) row.details = record.details
    }
    const versions = record.versions.filter((version) => !same.some((row) => row.versions.includes(version)))
    if (versions.length > 0) added.push({ ...record, versions })
  }
  return [...rows, ...added]
}

// Whether npm's registry serves `name` to anyone: a HEAD with no token,
// answered 2xx. Private packages and other registries' answer 404; any
// other answer, or none, counts as private too, as in triage.
async function servesAnyone(name) {
  try {
    return await answersHead(buildUrl(NPM_REGISTRY, name.split('/')))
  } catch {
    return false
  }
}

// The packages of `asked` whose name is public (servesAnyone). The name
// decides, not the version: npm takes down malicious versions but keeps
// their name. Public names are kept a month, as a scoped package can be
// made private; the rest are asked again each time.
async function publicOnly(asked, cache) {
  const names = [...asked.keys()]
  const kept = await pool(names, NAMES_AT_ONCE, (name) => readRecord('npm/public', name, cache))
  const missing = names.filter((name, i) => kept[i]?.public !== true)
  const found = await pool(missing, NAMES_AT_ONCE, servesAnyone)
  const added = missing.filter((name, i) => found[i])
  await pool(added, NAMES_AT_ONCE, (name) => writeRecord('npm/public', name, { public: true }, cache))
  const serving = new Set([...names.filter((name, i) => kept[i]?.public === true), ...added])
  return new Map([...asked].filter(([name]) => serving.has(name)))
}

// OSV's records of the public packages only: no request to OSV names a
// private one.
async function osvOfPublic(asked, options) {
  const told = await publicOnly(asked, options.cache)
  return told.size > 0 ? await osvRows({ osv: 'npm' }, told, options) : []
}

// What `npm audit` asks the registry, one row per vulnerable range, and
// with `osv`, OSV's records of the public packages.
export const NPM = {
  assertName: assertPackageName,
  assertVersion: assertPackageVersion,
  compare: compareVersions,
  advisories: async (asked, options) => {
    const [registry, osv] = await Promise.all([registryAdvisories(asked), options.osv ? osvOfPublic(asked, options) : []])
    const rows = withOsv(registry, osv)
    return await withRepositories(options.details ? await withDetails(rows) : rows, asked, options, { ecosystem: 'npm', lookUp: npmRepos })
  },
}
