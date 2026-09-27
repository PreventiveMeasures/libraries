import assert from 'node:assert/strict'

import { assertArgs, assertion, isGhsa, isStrings, matches, optional, show } from '../args.js'
import { OSV_API, buildUrl, request } from '../http.js'
import { pool } from '../pool.js'
import { isExactVersion, satisfies } from '../semver.js'
import { affecting, askedVersions, order } from './common.js'
import { assertClient, repositoryAdvisories } from './github.js'
import { composerRepos, crateRepos } from './repos.js'

const QUERIES_PER_REQUEST = 1000
const CONCURRENCY = 8
const isOsvId = matches(/^[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)

const CRATES = {
  ecosystem: 'crates.io',
  github: 'rust',
  repos: crateRepos,
  assertName: assertion('a crate name', matches(/^[A-Za-z][\w-]{0,63}$/u)),
  assertVersion: assertion('a semver version', matches(/^(?=.{5,256}$)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u)),
  keep: (id) => id.startsWith('RUSTSEC-'), // What `cargo audit` reads; the GHSA records mirror it.
}
const COMPOSER = {
  ecosystem: 'Packagist',
  github: 'composer',
  repos: composerRepos,
  // Composer's `v1.2.3` is semver's 1.2.3; what semver cannot read at all
  // (1.2.3.4, 1.0.0-p1) is covered by every range.
  covers: (version, range) => {
    const plain = version.replace(/^v/iu, '')
    return !isExactVersion(plain) || satisfies(plain, range)
  },
  assertName: assertion('a Composer package name', matches(/^(?=.{3,256}$)[a-z\d](?:[_.-]?[a-z\d]+)*\/[a-z\d](?:(?:[_.]|-{1,2})?[a-z\d]+)*$/u)),
  assertVersion: assertion('a Composer release version', matches(/^(?=.{1,64}$)v?\d+(?:\.\d+){0,3}(?:[._-]?(?:stable|beta|b|RC|alpha|a|patch|pl|p)(?:[.-]?\d+)*)?$/iu)),
}

async function getVuln(method, id) {
  const record = await request(buildUrl(OSV_API, ['v1', 'vulns', id]), { as: 'json' })
  assert.ok(record?.id === id, `${method}: OSV answered for ${show(record?.id)}, not ${id}`)
  assert.ok((record.aliases === undefined || isStrings(record.aliases)) && ['summary', 'withdrawn'].every((key) => record[key] === undefined || typeof record[key] === 'string'), `${method}: malformed OSV record ${id}`)
  return { ...record, aliases: record.aliases ?? [] }
}

function toAdvisory(ecosystem, name, versions, record) {
  const { aliases } = record
  const ghsas = aliases.filter(isGhsa)
  const ghsa = isGhsa(record.id) ? record.id : (ghsas.length === 1 ? ghsas[0] : undefined)
  const severity = record.database_specific?.severity
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
    ...(typeof severity === 'string' && { severity: severity.toLowerCase() }),
    ...(typeof vector === 'string' && { cvssVector: vector }),
    ...(typeof informational === 'string' && { informational }),
    versions,
  }
}

// OSV's batch query matches versions on its side, but answers ids only:
// each record is fetched once after. A record another database also
// publishes comes back under both ids, so one that aliases a GHSA
// answered for the same package is left out.
async function osvAdvisories(method, config, packages, options = {}) {
  const { ecosystem, assertName, assertVersion, keep = () => true } = config
  const asked = askedVersions(method, packages, assertName, assertVersion)
  assertArgs(method, options, { github: optional(assertClient) })
  const list = [...asked].flatMap(([name, versions]) => versions.map((version) => ({ name, version })))
  const hits = new Map() // id → name → versions, in `list` order
  for (let i = 0; i < list.length; i += QUERIES_PER_REQUEST) {
    const chunk = list.slice(i, i + QUERIES_PER_REQUEST)
    const body = { queries: chunk.map(({ name, version }) => ({ package: { name, ecosystem }, version })) }
    const answer = await request(buildUrl(OSV_API, ['v1', 'querybatch']), { method: 'POST', body, as: 'json' })
    assert.ok(Array.isArray(answer?.results) && answer.results.length === chunk.length, `${method}: expected one OSV result per query`)
    for (const [j, result] of answer.results.entries()) {
      const { name, version } = chunk[j]
      const vulns = result?.vulns ?? []
      assert.ok(result && result.next_page_token === undefined && Array.isArray(vulns) && vulns.every((vuln) => isOsvId(vuln?.id)), `${method}: malformed OSV result for ${name}@${version}`)
      for (const { id } of vulns.filter((vuln) => keep(vuln.id))) {
        const byName = hits.get(id) ?? hits.set(id, new Map()).get(id)
        byName.set(name, (byName.get(name) ?? new Set()).add(version))
      }
    }
  }
  const records = await pool([...hits.keys()], CONCURRENCY, (id) => getVuln(method, id))
  const advisories = []
  for (const record of records) {
    if (record.withdrawn) continue
    for (const [name, versions] of hits.get(record.id)) {
      const shadowed = !isGhsa(record.id) && record.aliases.some((alias) => isGhsa(alias) && hits.get(alias)?.has(name))
      if (!shadowed) advisories.push(toAdvisory(ecosystem, name, [...versions], record))
    }
  }
  advisories.sort((a, b) => order(a.name, b.name) || order(a.id, b.id))
  if (!options.github) return advisories
  // As for npm: what each package's repository publishes that OSV did not
  // answer with, by GHSA id or alias.
  const reported = new Set(advisories.flatMap(({ name, id, aliases }) => [id, ...aliases].filter(isGhsa).map((ghsa) => `${name} ${ghsa}`)))
  const repos = await config.repos([...asked.keys()])
  const takes = (name, pkg, advisory) => pkg?.ecosystem === config.github && pkg.name === name && !reported.has(`${name} ${advisory.ghsa_id}`)
  return affecting([...advisories, ...await repositoryAdvisories(method, options.github, asked, { repoOf: (name) => repos.get(name), takes, covers: config.covers })])
}

export const cargoAdvisories = (packages, options) => osvAdvisories('cargoAdvisories', CRATES, packages, options)
// TODO: packagist.org's API, what `composer audit` reads, also has the
// FriendsOfPHP advisories OSV lacks; using it means matching Composer
// version ranges here.
export const composerAdvisories = (packages, options) => osvAdvisories('composerAdvisories', COMPOSER, packages, options)
