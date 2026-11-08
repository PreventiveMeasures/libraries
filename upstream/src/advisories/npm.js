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
// Each a small document, answered in about a tenth of a second.
const NAMES_AT_ONCE = 32

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
// asked once, unless `osv` already read it.
async function withDetails(rows) {
  const asks = (row) => row.source === 'registry' && row.details === undefined
  const ghsas = [...new Set(rows.filter((row) => asks(row) && row.ghsa && row.versions.length > 0).map((row) => row.ghsa))]
  const records = await pool(ghsas, RECORDS_AT_ONCE, (ghsa) => getVuln(ghsa).catch(recover(isNotFound, undefined)))
  const text = new Map(ghsas.map((ghsa, i) => [ghsa, records[i]?.details]))
  return rows.map((row) => (asks(row) ? { ...row, ...detailsOf(text.get(row.ghsa), row.ghsa) } : row))
}

// With `osv`, OSV's records too, malware's among them. A version a registry
// row reports under the same advisory is left to that row, which takes the
// record's ids as aliases.
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

// Whether npm serves `name` without a token: its latest version's document,
// else (no `latest` tag) a HEAD of the package's; anything but 200 is
// private, as in triage. That order, as the HEAD is often slow.
async function servesAnyone(name) {
  try {
    const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), 'latest']), { as: 'json' })
    return json?.name === name
  } catch (err) {
    if (!isNotFound(err)) return false
  }
  try {
    return await answersHead(buildUrl(NPM_REGISTRY, name.split('/')))
  } catch {
    return false
  }
}

// The name decides, not the version: npm takes down malicious versions but
// keeps their name. Only public names are cached, a month.
async function publicOnly(asked, cache) {
  const names = [...asked.keys()]
  const kept = await pool(names, NAMES_AT_ONCE, (name) => readRecord('npm/public', name, cache))
  const serving = new Set(names.filter((name, i) => kept[i]?.public === true))
  const missing = names.filter((name) => !serving.has(name))
  const found = await pool(missing, NAMES_AT_ONCE, servesAnyone)
  const added = missing.filter((name, i) => found[i])
  await pool(added, NAMES_AT_ONCE, (name) => writeRecord('npm/public', name, { public: true }, cache))
  for (const name of added) serving.add(name)
  return new Map([...asked].filter(([name]) => serving.has(name)))
}

// No request to OSV names a private package.
async function osvOfPublic(asked, options) {
  const told = await publicOnly(asked, options.cache)
  return told.size > 0 ? await osvRows({ osv: 'npm' }, told, options) : []
}

// What `npm audit` asks, and with `osv`, OSV's records of public packages.
export const NPM = {
  github: 'npm',
  lookUp: npmRepos,
  assertName: assertPackageName,
  assertVersion: assertPackageVersion,
  compare: compareVersions,
  advisories: async (asked, options) => {
    const [registry, osv] = await Promise.all([registryAdvisories(asked), options.osv ? osvOfPublic(asked, options) : []])
    const rows = withOsv(registry, osv)
    return await withRepositories(options.details ? await withDetails(rows) : rows, asked, options, NPM)
  },
}
