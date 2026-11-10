import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { parseYaml } from '@preventive/lockfile/yaml.js'

import { assertion, isGhsa, isSha, isStrings, matches } from '../args.js'
import { readJSON, readRecord, writeJSON, writeRecord } from '../cache.js'
import { pool } from '../pool.js'
import { compareVersions, readRange } from '../rubygems/version.js'
import { objectId } from '../tree.js'
import { advisoryUrl, detailsOf, isText, metrics, order } from './common.js'

// ruby-advisory-db: `gems/<gem>/<id>.yml`, what `bundler-audit` reads, and
// `rubies/<engine>/<id>.yml`, what `ruby-audit` does.
const DB = 'rubysec/ruby-advisory-db'
// How late an advisory added to it can be seen.
const LISTING_TTL_MS = 90 * 60 * 1000
// Raised when what is kept changes.
const VERSION = 2
const FILES_AT_ONCE = 8
const FILE = /^(?<dir>gems|rubies)\/(?<name>[^/]+)\/(?<id>[\w.-]+)\.yml$/u
const isId = matches(/^(?=.{1,128}$)[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)
const isFile = (entry) => Array.isArray(entry) && entry.length === 4 && ['gems', 'rubies'].includes(entry[0]) && typeof entry[1] === 'string' && typeof entry[2] === 'string' && isSha(entry[3])
const isDigest = (value) => value?.v === VERSION && isId(value.id) && isStrings(value.aliases) && isText(value.title) && isStrings(value.unaffected) && isStrings(value.patched)

// Each advisory file's directory, gem or engine, id and blob, from one listing
// of the repository.
async function listRepository(github, cache) {
  const kept = await readRecord('rubysec/index', 'gems', cache, LISTING_TTL_MS)
  if (kept?.v === VERSION && isSha(kept.oid) && Array.isArray(kept.files) && kept.files.every(isFile)) return kept
  const { oid } = await github.getRepoHead({ repo: DB, branch: 'master' })
  const { entries, cut } = await github.listRepoTree({ repo: DB, sha: oid })
  assert.ok(!cut, `advisories: GitHub's listing of ${DB} is cut short`)
  const files = entries.flatMap(({ path, type, sha }) => {
    const found = type === 'blob' && FILE.exec(path)
    return found ? [[found.groups.dir, found.groups.name, found.groups.id, sha]] : []
  })
  await writeRecord('rubysec/index', 'gems', { v: VERSION, oid, files }, cache)
  return { oid, files }
}

// Gems and Rubies asked at once share the one listing in flight.
const inFlight = new WeakMap()
function listing(github, cache) {
  const calls = inFlight.get(github) ?? inFlight.set(github, new Map()).get(github)
  if (!calls.has(cache)) calls.set(cache, listRepository(github, cache).finally(() => calls.delete(cache)))
  return calls.get(cache)
}

// One value or a list of them, as Array() reads it.
const list = (value) => (value == null ? [] : [value].flat())
// `CVE-2024-1` of `2024-1` and of `CVE-2024-1` alike.
const ids = (prefix, values) => values.filter((value) => value !== '').map((value) => (String(value).startsWith(prefix) ? String(value) : `${prefix}${value}`))
const score = (value) => (typeof value === 'number' ? value : (/^(?:\d+\.?\d*|\.\d+)$/u.test(value ?? '') ? Number(value) : undefined))
// bundler-audit's criticality, from a v3 score (or a v4's), else a v2's.
const V3 = [[9, 'critical'], [7, 'high'], [4, 'moderate'], [0.1, 'low']]
const V2 = [[7, 'high'], [4, 'moderate'], [0, 'low']]
const rate = (value, scale) => scale.find(([from]) => value >= from)?.[1]

// Its ids as bundler-audit has them, `related`'s too, going by the GHSA where
// there is one. Lockfile's reader refuses a date and `.17`, so `date` is
// dropped and CVSS scores quoted.
function digest(dir, name, file, yaml) {
  const what = `advisories: ${DB} ${dir}/${name}/${file}.yml`
  let doc
  try {
    doc = parseYaml(yaml.replace(/^date: .*$/mu, '').replaceAll(/^(cvss_v[234]): ([\d.]+)$/gmu, '$1: "$2"'), { workflow: true })
  } catch (cause) {
    throw new Error(`${what}: ${cause.message}`, { cause })
  }
  const { title, description, url } = doc
  const related = doc.related ?? {}
  const [unaffected, patched] = [doc.unaffected_versions, doc.patched_versions].map(list)
  const of = doc[dir === 'gems' ? 'gem' : 'engine']
  assert.ok(of === name, `${what} is of ${JSON.stringify(of)}, not ${name}`)
  assert.ok([title, description, url].every((value) => value == null || isText(value)) && related && typeof related === 'object' && isStrings(unaffected) && isStrings(patched), `${what} is malformed`)
  const id = ids('GHSA-', list(doc.ghsa)).find(isGhsa) ?? file
  assert.ok(isId(id), `${what} has no id`)
  const all = [...ids('GHSA-', [...list(doc.ghsa), ...list(related.ghsa)]), ...ids('CVE-', [...list(doc.cve), ...list(related.cve)]), ...ids('OSVDB-', [...list(doc.osvdb), ...list(related.osvdb)]), file]
  const [v2, v3] = [score(doc.cvss_v2), score(doc.cvss_v3) ?? score(doc.cvss_v4)]
  const severity = v3 === undefined ? v2 !== undefined && rate(v2, V2) : rate(v3, V3)
  return {
    v: VERSION,
    id,
    aliases: [...new Set(all.filter(isId))].filter((other) => other !== id),
    title: title ?? id,
    ...(description && { description }),
    ...(/^https?:$/u.test(URL.parse(url)?.protocol) && { url }),
    ...((v3 ?? v2) !== undefined && { cvss: v3 ?? v2 }),
    ...(severity && { severity }),
    unaffected,
    patched,
  }
}

// Kept for good by its blob, which names its content.
async function advisoryOf(github, oid, [dir, name, file, sha], cache) {
  const kept = await readJSON('rubysec/advisories', sha, cache)
  if (isDigest(kept)) return kept
  const path = `${dir}/${name}/${file}.yml`
  const yaml = await github.getRepoFile({ repo: DB, path, ref: oid })
  assert.ok(objectId('blob', Buffer.from(yaml)).toString('hex') === sha, `advisories: ${DB} ${path} at ${oid} is not blob ${sha}`)
  const found = digest(dir, name, file, yaml)
  await writeJSON('rubysec/advisories', sha, found, cache)
  return found
}

// As bundler-audit: vulnerable unless a patched or unaffected entry takes
// the version; one the port can't read takes none.
function toRow(name, advisory, asked, details, versionOf) {
  const takes = [...advisory.patched, ...advisory.unaffected].map(readRange).filter(Boolean)
  const ghsa = isGhsa(advisory.id) ? advisory.id : undefined
  const url = ghsa ? advisoryUrl(ghsa) : advisory.url
  return {
    name,
    source: 'rubysec',
    id: advisory.id,
    ...(ghsa && { ghsa }),
    ...(url && { url }),
    aliases: advisory.aliases,
    title: advisory.title,
    ...(details && detailsOf(advisory.description, advisory.id)),
    ...metrics({ severity: advisory.severity, score: advisory.cvss }),
    versions: asked.filter((version) => !takes.some((test) => test(versionOf(version)))),
  }
}

// The listing first, then the files of the asked names under `dir` alone.
export async function rubysecRows(github, asked, { details, cache }, dir = 'gems', versionOf = (version) => version) {
  const { oid, files } = await listing(github, cache)
  const wanted = files.filter(([under, name]) => under === dir && asked.has(name))
  const advisories = await pool(wanted, FILES_AT_ONCE, (entry) => advisoryOf(github, oid, entry, cache))
  return wanted.map(([, name], i) => toRow(name, advisories[i], asked.get(name), details, versionOf))
}

// Bundler's `3.3.6p108` as ruby-audit matches it, `3.3.6.108`; a preview's
// `p-1` is no patchlevel.
const release = (version) => version.replace(/(?<=\d)p(?:-1|(\d+))$/u, (_, level) => (level === undefined ? '' : `.${level}`))

export const RUBY = {
  repositoryOnly: true,
  assertName: assertion('a Ruby engine, `ruby` or `jruby` say', matches(/^[a-z][\da-z]{0,31}$/u)),
  assertVersion: assertion('a Ruby version as Bundler writes one, `3.3.6p108`', matches(/^(?=.{5,64}$)\d+\.\d+\.\d+(?:\.[\dA-Za-z]+)*(?:p(?:-1|0|[1-9]\d*))?$/u)),
  compare: (a, b) => compareVersions(release(a), release(b)) || order(a, b),
  advisories: (asked, { github, details, cache }) => rubysecRows(github, asked, { details, cache }, 'rubies', release),
}

// One without a GHSA that OSV has under another id (its CVE an alias of
// OSV's GHSA record) takes that id, to be one row with OSV's.
export function sameIds(rows, osv) {
  const idOf = new Map()
  for (const row of osv) for (const id of [row.id, ...row.aliases]) if (!idOf.has(`${row.name} ${id}`)) idOf.set(`${row.name} ${id}`, row.id)
  return rows.map((row) => {
    const id = isGhsa(row.id) ? undefined : [row.id, ...row.aliases].map((each) => idOf.get(`${row.name} ${each}`)).find(Boolean)
    return id === undefined ? row : { ...row, id, aliases: [row.id, ...row.aliases].filter((each) => each !== id) }
  })
}
