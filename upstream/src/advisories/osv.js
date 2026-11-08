import assert from 'node:assert/strict'

import { assertCrateName, assertCrateVersion, assertGemName, assertGemVersion, assertion, isGhsa, isRepo, isStrings, matches, show } from '../args.js'
import { OSV_API, buildUrl, request } from '../http.js'
import { chunks, pool } from '../pool.js'
import { assertPypiName, assertPypiVersion, boundRange as boundPypiRange, compareVersions as comparePypiVersions, normalName, readRange as readPypiRange } from '../pypi/version.js'
import { boundRange as boundGemRange, compareVersions as compareGemVersions, readRange as readGemRange } from '../rubygems/version.js'
import { isExactVersion } from '../semver.js'
import { advisoryUrl, detailsOf, inRange, isText, metrics, order } from './common.js'
import { bySemver, withRepositories } from './github.js'
import { composerRepos, crateRepos, gemRepos, pypiRepos } from './repos.js'
import { rubysecRows, sameIds } from './rubysec.js'

const QUERY_URL = buildUrl(OSV_API, ['v1', 'querybatch'])
const QUERIES_PER_REQUEST = 1000
export const RECORDS_AT_ONCE = 8
const isOsvId = matches(/^(?=.{1,128}$)[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)
// An id that is only another's alias (PKSA-...) has no page of its own.
const osvPage = (id) => `https://osv.dev/vulnerability/${id}`
const INFORMATIONAL = new Set(['unmaintained', 'unsound', 'notice'])
// Of one advisory's records, which a version is reported under: RustSec's
// (what `cargo audit` reads), then the GHSA, then by id.
const rank = (id) => (id.startsWith('RUSTSEC-') ? 0 : (isGhsa(id) ? 1 : 2))
const first = (a, b) => rank(a.id) - rank(b.id) || order(a.id, b.id)
const named = (a, b) => a.aliases.includes(b.id) || b.aliases.includes(a.id)

export const CARGO = {
  osv: 'crates.io',
  github: 'rust',
  lookUp: crateRepos,
  assertName: assertCrateName,
  assertVersion: assertCrateVersion,
  advisories: (asked, options) => osvAdvisories(CARGO, asked, options),
}
// TODO: packagist.org's API, what `composer audit` reads, has the
// FriendsOfPHP advisories OSV lacks; it needs Composer range matching.
export const COMPOSER = {
  osv: 'Packagist',
  github: 'composer',
  lookUp: composerRepos,
  assertName: assertion('a Composer package name', matches(/^(?=.{3,256}$)[a-z\d](?:[_.-]?[a-z\d]+)*\/[a-z\d](?:(?:[_.]|-{1,2})?[a-z\d]+)*$/u)),
  assertVersion: assertion('a Composer release version', matches(/^(?=.{1,64}$)v?\d+(?:\.\d+){0,3}(?:[._-]?(?:stable|beta|b|RC|alpha|a|patch|pl|p)(?:[.-]?\d+)*)?$/iu)),
  // What semver can't read (1.2.3.4, 1.0.0-p1) is covered by every range.
  versionsIn: bySemver((version, range) => {
    const plain = version.replace(/^v/iu, '')
    return !isExactVersion(plain) || inRange(plain, range)
  }),
  advisories: (asked, options) => osvAdvisories(COMPOSER, asked, options),
}

// OSV, and with a GitHub client ruby-advisory-db, which OSV lacks.
export const GEM = {
  osv: 'RubyGems',
  github: 'rubygems',
  lookUp: gemRepos,
  assertName: assertGemName,
  assertVersion: assertGemVersion,
  // `1.0` and `1.0.0` are equal, so are ordered by their text.
  compare: (a, b) => compareGemVersions(a, b) || order(a, b),
  bound: boundGemRange,
  versionsIn: (asked, range) => {
    const test = readGemRange(range)
    return test === undefined ? [...asked] : asked.filter(test)
  },
  advisories: async (asked, options) => {
    const [osv, rubysec] = await Promise.all([osvRows(GEM, asked, options), options.github ? rubysecRows(options.github, asked, options) : []])
    return await withRepositories([...osv, ...sameIds(rubysec, osv)], asked, options, GEM)
  },
}

// As OSV's SwiftURL names it, `github.com/vapor/vapor`, case and all.
const SWIFT_NAME = /^(?=.{1,512}$)[a-z\d-]+(?:\.[a-z\d-]+)+(?:\/(?!\.\.?(?:\/|$))[\w.~-]+)+(?<!\.git)$/u
// TSCUtility.Version: SemVer, but an identifier may be empty, or a number
// have a leading zero.
const SWIFT_VERSION = /^(?=.{5,256}$)(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:-[\dA-Za-z.-]*)?(?:\+[\dA-Za-z.-]*)?$/u
const swiftRepo = (name) => {
  const repo = name.startsWith('github.com/') ? name.slice('github.com/'.length) : ''
  return isRepo(repo) ? repo : null
}

export const SWIFT = {
  osv: 'SwiftURL',
  github: 'swift',
  lookUp: (names) => new Map(names.map((name) => [name, swiftRepo(name)])),
  assertName: assertion("a Swift package's repository as OSV names it, `github.com/owner/name`", matches(SWIFT_NAME)),
  assertVersion: assertion('a version as SwiftPM writes one', matches(SWIFT_VERSION)),
  advisories: (asked, options) => osvAdvisories(SWIFT, asked, options),
}

// What `pip-audit` reads. OSV takes a name in any spelling PEP 503
// normalizes alike.
export const PYPI = {
  osv: 'PyPI',
  github: 'pip',
  lookUp: pypiRepos,
  assertName: assertPypiName,
  assertVersion: assertPypiVersion,
  nameKey: normalName,
  // `1.0` and `1.0.0` are equal, so are ordered by their text.
  compare: (a, b) => comparePypiVersions(a, b) || order(a, b),
  bound: boundPypiRange,
  versionsIn: (asked, range) => {
    const test = readPypiRange(range)
    return test === undefined ? [...asked] : asked.filter(test)
  },
  advisories: (asked, options) => osvAdvisories(PYPI, asked, options),
}

export async function getVuln(id) {
  const record = await request(buildUrl(OSV_API, ['v1', 'vulns', id]), { as: 'json' })
  assert.ok(record?.id === id, `advisories: OSV answered for ${show(record?.id)}, not ${id}`)
  assert.ok((record.aliases === undefined || isStrings(record.aliases)) && (record.summary === undefined || isText(record.summary))
    && (record.withdrawn === undefined || typeof record.withdrawn === 'string'), `advisories: malformed OSV record ${id}`)
  return { ...record, aliases: (record.aliases ?? []).filter(isOsvId) }
}

function toAdvisory(ecosystem, name, versions, record, details) {
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
    url: ghsa ? advisoryUrl(ghsa) : osvPage(record.id),
    aliases,
    ...(record.summary && { title: record.summary }),
    ...(details && detailsOf(record.details, record.id)),
    ...metrics({ severity: record.database_specific?.severity, vector, cwe: record.database_specific?.cwe_ids }),
    ...(INFORMATIONAL.has(informational) && { informational }),
    versions,
  }
}

// OSV's batch query answers ids only, each record fetched after. Records
// of one advisory, naming each other as aliases, are one group: each
// version is reported under its first, the rest its aliases.
export async function osvRows({ osv }, asked, { details }) {
  const list = [...asked].flatMap(([name, versions]) => versions.map((version) => ({ name, version })))
  const hits = new Map() // id -> name -> versions, in `list` order
  for (const chunk of chunks(list, QUERIES_PER_REQUEST)) {
    const body = { queries: chunk.map(({ name, version }) => ({ package: { name, ecosystem: osv }, version })) }
    const answer = await request(QUERY_URL, { method: 'POST', body, as: 'json' })
    assert.ok(Array.isArray(answer?.results) && answer.results.length === chunk.length, 'advisories: expected one OSV result per query')
    for (const [j, result] of answer.results.entries()) {
      const { name, version } = chunk[j]
      const vulns = result?.vulns ?? []
      assert.ok(result && result.next_page_token === undefined && Array.isArray(vulns) && vulns.every((vuln) => isOsvId(vuln?.id)), `advisories: malformed OSV result for ${name}@${version}`)
      for (const { id } of vulns) {
        const byName = hits.get(id) ?? hits.set(id, new Map()).get(id)
        byName.set(name, (byName.get(name) ?? new Set()).add(version))
      }
    }
  }
  const records = (await pool([...hits.keys()], RECORDS_AT_ONCE, getVuln)).filter((record) => !record.withdrawn)
  const groups = new Map()
  for (const record of records) {
    if (groups.has(record)) continue
    const group = [record]
    for (const member of group) group.push(...records.filter((other) => !group.includes(other) && named(member, other)))
    for (const member of group) groups.set(member, group)
  }
  const rows = []
  for (const record of records) {
    const group = groups.get(record)
    const above = group.filter((other) => first(other, record) < 0)
    const aliases = [...new Set([...record.aliases, ...group.map((other) => other.id)])].filter((id) => id !== record.id)
    for (const [name, versions] of hits.get(record.id)) {
      const rest = [...versions].filter((version) => !above.some((other) => hits.get(other.id).get(name)?.has(version)))
      if (rest.length > 0) rows.push(toAdvisory(osv, name, rest, { ...record, aliases }, details))
    }
  }
  rows.sort((a, b) => order(a.name, b.name) || order(a.id, b.id))
  return rows
}

async function osvAdvisories(ecosystem, asked, options) {
  return await withRepositories(await osvRows(ecosystem, asked, options), asked, options, ecosystem)
}
