import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { parseYaml } from '@preventive/lockfile/yaml.js'

import { isGhsa, isSha, isStrings, matches } from '../args.js'
import { readJSON, readRecord, writeJSON, writeRecord } from '../cache.js'
import { pool } from '../pool.js'
import { readRange } from '../rubygems/version.js'
import { objectId } from '../tree.js'
import { advisoryUrl, detailsOf, isText, metrics } from './common.js'

// ruby-advisory-db, what `bundler-audit` reads: `gems/<gem>/<id>.yml`, one
// advisory each.
const DB = 'rubysec/ruby-advisory-db'
// How late an advisory added to it can be seen.
const LISTING_TTL_MS = 90 * 60 * 1000
// Stamped on what is kept, and raised when it is kept differently.
const VERSION = 1
const FILES_AT_ONCE = 8
const FILE = /^gems\/(?<gem>[^/]+)\/(?<id>[\w.-]+)\.yml$/u
const isId = matches(/^(?=.{1,128}$)[A-Z][\dA-Z]*(?:-[\dA-Za-z]+)+$/u)
const isFile = (entry) => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && isSha(entry[2])
const isDigest = (value) => value?.v === VERSION && isId(value.id) && isStrings(value.aliases) && isText(value.title) && isStrings(value.unaffected) && isStrings(value.patched)

// Each advisory file's gem, id and blob, at the commit `oid`: one listing
// of the whole repository, kept 90 minutes.
async function listing(github, cache) {
  const kept = await readRecord('rubysec/index', 'gems', cache, LISTING_TTL_MS)
  if (kept?.v === VERSION && isSha(kept.oid) && Array.isArray(kept.files) && kept.files.every(isFile)) return kept
  const { oid } = await github.getRepoHead({ repo: DB, branch: 'master' })
  const { entries, cut } = await github.listRepoTree({ repo: DB, sha: oid })
  assert.ok(!cut, `advisories: GitHub's listing of ${DB} is cut short`)
  const files = entries.flatMap(({ path, type, sha }) => {
    const found = type === 'blob' && FILE.exec(path)
    return found ? [[found.groups.gem, found.groups.id, sha]] : []
  })
  await writeRecord('rubysec/index', 'gems', { v: VERSION, oid, files }, cache)
  return { oid, files }
}

// A field that may be one value or a list of them, as Array() reads it.
const list = (value) => (value == null ? [] : [value].flat())
// `CVE-2024-1` of `2024-1` and of `CVE-2024-1` alike.
const ids = (prefix, values) => values.filter((value) => value !== '').map((value) => (String(value).startsWith(prefix) ? String(value) : `${prefix}${value}`))
const score = (value) => (typeof value === 'number' ? value : undefined)
// bundler-audit's criticality, from a v3 score (or a v4's), else a v2's.
const V3 = [[9, 'critical'], [7, 'high'], [4, 'moderate'], [0.1, 'low']]
const V2 = [[7, 'high'], [4, 'moderate'], [0, 'low']]
const rate = (value, scale) => scale.find(([from]) => value >= from)?.[1]

// What rows are made from, of one file: its ids as bundler-audit has them
// (CVE-, OSVDB-, GHSA- and the file's own), `related`'s too, going by the
// GHSA where it has one; its CVSS score, v3's, else v4's, else v2's; and
// its requirements as written. Its `date`, a scalar the reader refuses as
// YAML would type it a date, is not read.
function digest(gem, file, yaml) {
  const what = `advisories: ${DB} gems/${gem}/${file}.yml`
  let doc
  try {
    doc = parseYaml(yaml.replace(/^date: .*$/mu, ''), { workflow: true })
  } catch (cause) {
    throw new Error(`${what}: ${cause.message}`, { cause })
  }
  const { title, description, url } = doc
  const related = doc.related ?? {}
  const [unaffected, patched] = [doc.unaffected_versions, doc.patched_versions].map(list)
  assert.ok(doc.gem === gem, `${what} is of ${JSON.stringify(doc.gem)}, not ${gem}`)
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

// A file's digest, kept for good by its blob, which names its content.
async function advisoryOf(github, oid, [gem, file, sha], cache) {
  const kept = await readJSON('rubysec/advisories', sha, cache)
  if (isDigest(kept)) return kept
  const yaml = await github.getRepoFile({ repo: DB, path: `gems/${gem}/${file}.yml`, ref: oid })
  assert.ok(objectId('blob', Buffer.from(yaml)).toString('hex') === sha, `advisories: ${DB} gems/${gem}/${file}.yml at ${oid} is not blob ${sha}`)
  const found = digest(gem, file, yaml)
  await writeJSON('rubysec/advisories', sha, found, cache)
  return found
}

// As bundler-audit: a version is vulnerable unless a patched or unaffected
// entry, a Gem::Requirement of its `, `-separated parts, takes it. One the
// port can't read takes none.
function toRow(name, advisory, asked, details) {
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
    versions: asked.filter((version) => !takes.some((test) => test(version))),
  }
}

// The asked gems' advisories, through `github`: the listing first, then
// the files of the asked gems alone.
export async function rubysecRows(github, asked, { details, cache }) {
  const { oid, files } = await listing(github, cache)
  const wanted = files.filter(([gem]) => asked.has(gem))
  const advisories = await pool(wanted, FILES_AT_ONCE, (entry) => advisoryOf(github, oid, entry, cache))
  return wanted.map(([gem], i) => toRow(gem, advisories[i], asked.get(gem), details))
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
