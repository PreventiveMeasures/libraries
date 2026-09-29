import assert from 'node:assert/strict'

import { assertCrateName, assertCrateVersion, assertion, isGhsa, isStrings, matches, show } from '../args.js'
import { OSV_API, buildUrl, request } from '../http.js'
import { chunks, pool } from '../pool.js'
import { isExactVersion } from '../semver.js'
import { inRange, isText, metrics, order } from './common.js'
import { withRepositories } from './github.js'
import { composerRepos, crateRepos } from './repos.js'

const QUERY_URL = buildUrl(OSV_API, ['v1', 'querybatch'])
const QUERIES_PER_REQUEST = 1000
const RECORDS_AT_ONCE = 8
const isOsvId = matches(/^(?=.{1,128}$)[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)
const INFORMATIONAL = new Set(['unmaintained', 'unsound', 'notice'])

export const CARGO = {
  osv: 'crates.io',
  github: 'rust',
  lookUp: crateRepos,
  assertName: assertCrateName,
  assertVersion: assertCrateVersion,
  keep: (id) => id.startsWith('RUSTSEC-'), // What `cargo audit` reads; the GHSA records mirror it.
  advisories: (asked, options) => osvAdvisories(CARGO, asked, options),
}
// TODO: packagist.org's API, what `composer audit` reads, also has the
// FriendsOfPHP advisories OSV lacks; using it means matching Composer
// version ranges here.
export const COMPOSER = {
  osv: 'Packagist',
  github: 'composer',
  lookUp: composerRepos,
  assertName: assertion('a Composer package name', matches(/^(?=.{3,256}$)[a-z\d](?:[_.-]?[a-z\d]+)*\/[a-z\d](?:(?:[_.]|-{1,2})?[a-z\d]+)*$/u)),
  assertVersion: assertion('a Composer release version', matches(/^(?=.{1,64}$)v?\d+(?:\.\d+){0,3}(?:[._-]?(?:stable|beta|b|RC|alpha|a|patch|pl|p)(?:[.-]?\d+)*)?$/iu)),
  // Composer's `v1.2.3` is semver's 1.2.3; what semver cannot read at all
  // (1.2.3.4, 1.0.0-p1) is covered by every range.
  covers: (version, range) => {
    const plain = version.replace(/^v/iu, '')
    return !isExactVersion(plain) || inRange(plain, range)
  },
  advisories: (asked, options) => osvAdvisories(COMPOSER, asked, options),
}

async function getVuln(id) {
  const record = await request(buildUrl(OSV_API, ['v1', 'vulns', id]), { as: 'json' })
  assert.ok(record?.id === id, `advisories: OSV answered for ${show(record?.id)}, not ${id}`)
  assert.ok((record.aliases === undefined || isStrings(record.aliases)) && (record.summary === undefined || isText(record.summary))
    && (record.withdrawn === undefined || typeof record.withdrawn === 'string'), `advisories: malformed OSV record ${id}`)
  return { ...record, aliases: (record.aliases ?? []).filter(isOsvId) }
}

function toAdvisory(ecosystem, name, versions, record) {
  const { aliases } = record
  const ghsas = aliases.filter(isGhsa)
  const ghsa = isGhsa(record.id) ? record.id : (ghsas.length === 1 ? ghsas[0] : undefined)
  const vector = record.severity?.find?.((entry) => /^CVSS_V[34]$/u.test(entry?.type))?.score
  const affected = record.affected?.find?.((entry) => entry?.package?.ecosystem === ecosystem && entry.package.name === name)
  const informational = affected?.database_specific?.informational
  return {
    name,
    source: 'osv',
    id: record.id,
    ...(ghsa && { ghsa }),
    aliases,
    ...(record.summary && { title: record.summary }),
    ...metrics({ severity: record.database_specific?.severity, vector, cwe: record.database_specific?.cwe_ids }),
    ...(INFORMATIONAL.has(informational) && { informational }),
    versions,
  }
}

// OSV's batch query matches versions on its side, but answers ids only:
// each record is fetched once after. A record another database also
// publishes comes back under both ids, so one that aliases a GHSA keeps
// only the versions that GHSA was not answered for.
async function osvAdvisories(ecosystem, asked, options) {
  const { osv, github, lookUp, covers, keep = () => true } = ecosystem
  const list = [...asked].flatMap(([name, versions]) => versions.map((version) => ({ name, version })))
  const hits = new Map() // id → name → versions, in `list` order
  for (const chunk of chunks(list, QUERIES_PER_REQUEST)) {
    const body = { queries: chunk.map(({ name, version }) => ({ package: { name, ecosystem: osv }, version })) }
    const answer = await request(QUERY_URL, { method: 'POST', body, as: 'json' })
    assert.ok(Array.isArray(answer?.results) && answer.results.length === chunk.length, 'advisories: expected one OSV result per query')
    for (const [j, result] of answer.results.entries()) {
      const { name, version } = chunk[j]
      const vulns = result?.vulns ?? []
      assert.ok(result && result.next_page_token === undefined && Array.isArray(vulns) && vulns.every((vuln) => isOsvId(vuln?.id)), `advisories: malformed OSV result for ${name}@${version}`)
      for (const { id } of vulns.filter((vuln) => keep(vuln.id))) {
        const byName = hits.get(id) ?? hits.set(id, new Map()).get(id)
        byName.set(name, (byName.get(name) ?? new Set()).add(version))
      }
    }
  }
  const records = (await pool([...hits.keys()], RECORDS_AT_ONCE, getVuln)).filter((record) => !record.withdrawn)
  const live = new Set(records.map((record) => record.id))
  const rows = []
  for (const record of records) {
    for (const [name, versions] of hits.get(record.id)) {
      // Only the versions a live GHSA it aliases answered for too.
      const shadowed = isGhsa(record.id) ? [] : record.aliases.filter((alias) => isGhsa(alias) && live.has(alias)).flatMap((alias) => [...(hits.get(alias).get(name) ?? [])])
      const rest = [...versions].filter((version) => !shadowed.includes(version))
      if (rest.length > 0) rows.push(toAdvisory(osv, name, rest, record))
    }
  }
  rows.sort((a, b) => order(a.name, b.name) || order(a.id, b.id))
  return await withRepositories(rows, asked, options, { ecosystem: github, lookUp, covers })
}
