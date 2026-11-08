import assert from 'node:assert/strict'

import { allows, normalize, parseConstraints } from '@preventive/lockfile/composer-semver.js'

import { isGhsa, isStrings, matches, show } from '../args.js'
import { PACKAGIST, request } from '../http.js'
import { chunks } from '../pool.js'
import { advisoryUrl, isText, metrics } from './common.js'

// What `composer audit` reads. Its `/` is needed: without it, a 404.
const ADVISORIES_URL = `${PACKAGIST}/api/security-advisories/`
// POSTed, as a name can be 256 characters.
const NAMES_PER_REQUEST = 100
const isPksa = matches(/^PKSA(?:-[\da-z]{4}){3}$/u)
const isCve = matches(/^CVE-\d{4}-\d{4,}$/u)
const isUrl = (text) => /^https?:$/u.test(URL.parse(text)?.protocol)

const isAdvisory = (advisory, name) => advisory && typeof advisory === 'object' && isPksa(advisory.advisoryId) && advisory.packageName === name
  && isText(advisory.title) && typeof advisory.affectedVersions === 'string'
  && [advisory.cve, advisory.link, advisory.severity].every((value) => value == null || typeof value === 'string')
  && Array.isArray(advisory.sources) && isStrings(advisory.sources.map((source) => source?.remoteId))

// Its one GHSA, from its sources or its link, where it has one.
function ghsaOf({ sources, link }) {
  const ghsas = new Set([...sources.map((source) => source.remoteId), /\/(GHSA[\w-]+)$/u.exec(link ?? '')?.[1]].filter(isGhsa))
  return ghsas.size === 1 ? [...ghsas][0] : undefined
}

// As `composer audit` matches. A constraint or version Composer can't read
// is covered: a missed advisory is worse than a spare one.
function versionsIn(asked, constraints) {
  const parsed = parseConstraints(constraints)
  if (parsed === undefined) return [...asked]
  return asked.filter((version) => {
    const normal = normalize(version)
    return normal === undefined || allows(parsed, normal)
  })
}

function toRow(name, advisory, asked) {
  const ghsa = ghsaOf(advisory)
  const id = ghsa ?? advisory.advisoryId
  const url = isUrl(advisory.link) ? advisory.link : (ghsa && advisoryUrl(ghsa))
  return {
    name,
    source: 'packagist',
    id,
    ...(ghsa && { ghsa }),
    ...(url && { url }),
    aliases: [advisory.advisoryId, advisory.cve].filter((other) => (isPksa(other) || isCve(other)) && other !== id),
    title: advisory.title,
    ...metrics({ severity: advisory.severity }),
    range: advisory.affectedVersions,
    versions: versionsIn(asked, advisory.affectedVersions),
  }
}

// An answer of none is PHP's empty array, `[]`.
export async function packagistRows(asked) {
  const rows = []
  for (const chunk of chunks([...asked.keys()], NAMES_PER_REQUEST)) {
    const body = new TextEncoder().encode(new URLSearchParams(chunk.map((name) => ['packages[]', name])).toString())
    const answer = await request(ADVISORIES_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, as: 'json' })
    const found = Array.isArray(answer?.advisories) && answer.advisories.length === 0 ? {} : answer?.advisories
    assert.ok(found && typeof found === 'object' && !Array.isArray(found), 'advisories: expected an object of advisories from Packagist')
    for (const name of Object.keys(found)) assert.ok(chunk.includes(name), `advisories: Packagist answered for ${show(name)}, which was not asked`)
    for (const name of chunk) {
      const list = Object.hasOwn(found, name) ? found[name] : []
      assert.ok(Array.isArray(list) && list.every((advisory) => isAdvisory(advisory, name)), `advisories: malformed advisories from Packagist for ${name}`)
      rows.push(...list.map((advisory) => toRow(name, advisory, asked.get(name))))
    }
  }
  return rows
}
