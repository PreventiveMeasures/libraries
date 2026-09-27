import assert from 'node:assert/strict'

import { assertion, isGhsa, matches, show } from '../args.js'
import { OSV_API, buildUrl, request } from '../http.js'

const QUERIES_PER_REQUEST = 1000
const CONCURRENCY = 8
const isOsvId = matches(/^[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)
const isStrings = (value) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
const byVersion = new Intl.Collator('en', { numeric: true }).compare

const CRATES = {
  ecosystem: 'crates.io',
  assertName: assertion('a crate name', matches(/^[A-Za-z][\w-]{0,63}$/u)),
  assertVersion: assertion('a semver version', matches(/^(?=.{5,256}$)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u)),
  keep: (id) => id.startsWith('RUSTSEC-'), // What `cargo audit` reads; the GHSA records mirror it.
}
const PACKAGIST = {
  ecosystem: 'Packagist',
  assertName: assertion('a Composer package name', matches(/^(?=.{3,256}$)[a-z\d](?:[_.-]?[a-z\d]+)*\/[a-z\d](?:(?:[_.]|-{1,2})?[a-z\d]+)*$/u)),
  assertVersion: assertion('a Composer release version', matches(/^(?=.{1,64}$)v?\d+(?:\.\d+){0,3}(?:[._-]?(?:stable|beta|b|RC|alpha|a|patch|pl|p)(?:[.-]?\d+)*)?$/iu)),
  keep: () => true,
}

async function pool(items, fn) {
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

async function getVuln(method, id) {
  const record = await request(buildUrl(OSV_API, ['v1', 'vulns', id]), { as: 'json' })
  assert.ok(record?.id === id, `${method}: OSV answered for ${show(record?.id)}, not ${id}`)
  assert.ok(isStrings(record.aliases) && ['summary', 'withdrawn'].every((key) => record[key] === undefined || typeof record[key] === 'string'), `${method}: malformed OSV record ${id}`)
  return record
}

function toAdvisory(ecosystem, name, versions, record) {
  const aliases = record.aliases ?? []
  const ghsas = aliases.filter(isGhsa)
  const ghsa = isGhsa(record.id) ? record.id : (ghsas.length === 1 ? ghsas[0] : undefined)
  const severity = record.database_specific?.severity
  const vector = record.severity?.find?.((entry) => /^CVSS_V[34]$/u.test(entry?.type))?.score
  const affected = record.affected?.find?.((entry) => entry?.package?.ecosystem === ecosystem && entry.package.name === name)
  const informational = affected?.database_specific?.informational
  return {
    name,
    id: record.id,
    ...(ghsa && { ghsa }),
    aliases,
    ...(record.summary && { title: record.summary }),
    ...(typeof severity === 'string' && { severity: severity.toLowerCase() }),
    ...(typeof vector === 'string' && { cvssVector: vector }),
    ...(typeof informational === 'string' && { informational }),
    versions: [...versions].toSorted(byVersion),
  }
}

// OSV's batch query matches versions on its side, but answers ids only:
// each record is fetched once after. A record another database also
// publishes comes back under both ids, so one that aliases a GHSA
// answered for the same package is left out.
async function osvAdvisories(method, { ecosystem, assertName, assertVersion, keep }, packages) {
  assert.ok(typeof packages?.[Symbol.iterator] === 'function' && typeof packages !== 'string', `${method}: packages must be an iterable of { name, version }`)
  const queries = new Map()
  for (const pkg of packages) {
    assertName(method, 'name', pkg?.name)
    assertVersion(method, 'version', pkg.version)
    queries.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version })
  }
  const list = [...queries.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : byVersion(a.version, b.version)))
  const hits = new Map() // id → name → versions
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
  const ids = [...hits.keys()]
  const records = await pool(ids, (id) => getVuln(method, id))
  const advisories = []
  for (const [k, record] of records.entries()) {
    if (record.withdrawn) continue
    for (const [name, versions] of hits.get(ids[k])) {
      const shadowed = !isGhsa(record.id) && (record.aliases ?? []).some((alias) => isGhsa(alias) && hits.get(alias)?.has(name))
      if (!shadowed) advisories.push(toAdvisory(ecosystem, name, versions, record))
    }
  }
  return advisories.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
}

export const cargoAdvisories = (packages) => osvAdvisories('cargoAdvisories', CRATES, packages)
// TODO: packagist.org's API, what `composer audit` reads, also has the
// FriendsOfPHP advisories OSV lacks; using it means matching Composer
// version ranges here.
export const packagistAdvisories = (packages) => osvAdvisories('packagistAdvisories', PACKAGIST, packages)
