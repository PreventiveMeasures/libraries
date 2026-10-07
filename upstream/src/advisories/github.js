import assert from 'node:assert/strict'

import { assertRepo, assertSoldeerName, assertSoldeerVersion, assertion, isGhsa, isRefName, isStrings } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { isGone } from '../github/client.js'
import { recover } from '../http.js'
import { pool } from '../pool.js'
import { advisoryUrl, covered, detailsOf, isText, mayBeInRange, metrics } from './common.js'
import { soldeerRepos } from './repos.js'

const REPOS_AT_ONCE = 4
const DIR = 'github/advisories'
// A maintainer publishes one whenever they are ready, and seeing it before
// GitHub reviews it is what a repository is asked for: 90 minutes, not a month.
const LISTING_TTL_MS = 90 * 60 * 1000
// Stamped on each entry, and raised when a listing is kept differently.
const VERSION = 1

const isRepoAdvisory = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa_id)
  && advisory.state === 'published' && isText(advisory.summary)
  && (advisory.vulnerabilities == null || Array.isArray(advisory.vulnerabilities)) && (advisory.cwe_ids == null || isStrings(advisory.cwe_ids))

export const assertClient = assertion('a GitHub client from createClient', (value) => typeof value?.listRepoAdvisories === 'function')

// What rows are made from, and all that is kept of a listing: each advisory
// not withdrawn, with its CVSS vector GitHub prefers, and each vulnerable
// range with the package it names. A listing that is malformed is refused
// whole, and never kept; one whose only fault is a description (isDigest)
// is answered, but not kept either.
function digest(repo, list) {
  return list.flatMap((advisory) => {
    assert.ok(isRepoAdvisory(advisory), `advisories: malformed advisory from ${repo}`)
    if (advisory.withdrawn_at) return []
    const cvss = [advisory.cvss_severities?.cvss_v3, advisory.cvss_severities?.cvss_v4, advisory.cvss].find((entry) => typeof entry?.vector_string === 'string')
    const ranges = (advisory.vulnerabilities ?? []).map((vulnerability) => {
      const range = vulnerability?.vulnerable_version_range ?? ''
      assert.ok(typeof range === 'string', `advisories: malformed range in ${advisory.ghsa_id}`)
      const { ecosystem, name } = vulnerability?.package ?? {}
      return { range, ...(typeof ecosystem === 'string' && { ecosystem }), ...(typeof name === 'string' && { name }) }
    })
    return [{
      ghsa: advisory.ghsa_id,
      title: advisory.summary,
      ...(advisory.description != null && advisory.description !== '' && { description: advisory.description }),
      ...metrics({ severity: advisory.severity, score: cvss?.score, vector: cvss?.vector_string, cwe: advisory.cwe_ids }),
      ranges,
    }]
  })
}

// A description is checked only for `details` (detailsOf), so a malformed
// one leaves the listing usable, but not kept.
const isDigest = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa) && isText(advisory.title)
  && (advisory.description === undefined || isText(advisory.description))
  && Array.isArray(advisory.ranges) && advisory.ranges.every((entry) => typeof entry?.range === 'string')

// A repository's listing, digested, through the cache: GitHub's names are
// case-insensitive, so one entry answers every spelling. A repository gone,
// renamed or blocked has none, and that is not kept.
async function listAdvisories(github, repo, cache) {
  const name = repo.toLowerCase()
  const entry = await readRecord(DIR, name, cache, LISTING_TTL_MS)
  if (entry?.v === VERSION && Array.isArray(entry.advisories) && entry.advisories.every(isDigest)) return entry.advisories
  const list = await github.listRepoAdvisories({ repo }).catch(recover(isGone, null))
  if (list === null) return []
  const advisories = digest(repo, list)
  if (advisories.every(isDigest)) await writeRecord(DIR, name, { v: VERSION, advisories }, cache)
  return advisories
}

// GitHub's `>= 1.0.0, < 1.2.6` is npm's with the commas dropped.
// Maintainers write these unreviewed: one without a range, or with one
// semver cannot read, covers every version. Its page is on `repo`, which
// may publish it long before the advisory database has one, and its
// `description` is the text `details` asks for: the listing has it all.
function fromRepository(repo, name, advisory, range, asked, { covers, details }) {
  return {
    name,
    source: 'repository',
    id: advisory.ghsa,
    ghsa: advisory.ghsa,
    url: advisoryUrl(advisory.ghsa, repo),
    aliases: [],
    title: advisory.title,
    ...(details && detailsOf(advisory.description, advisory.ghsa)),
    ...metrics({ severity: advisory.severity, score: advisory.cvss, vector: advisory.cvssVector, cwe: advisory.cwe }),
    range,
    versions: covered(asked, range.replaceAll(',', ' '), covers),
  }
}

// Each asked name's repository, `repoOf` it, is asked once, and its
// advisories' vulnerable ranges become rows for the names that `takes` a
// range's package, one per name, advisory and range, holding the asked
// versions it `covers`, and with `details`, its text.
async function repositoryAdvisories(github, asked, { repoOf, takes = () => true, covers, details, cache }) {
  // GitHub's names are case-insensitive: one spelling asks for all.
  const namesOf = Map.groupBy([...asked.keys()].filter(repoOf), (name) => repoOf(name).toLowerCase())
  const listed = await pool([...namesOf.values()], REPOS_AT_ONCE, async (names) => ({ repo: repoOf(names[0]), names, list: await listAdvisories(github, repoOf(names[0]), cache) }))
  const rows = new Map()
  for (const { repo, names, list } of listed) {
    for (const advisory of list) {
      for (const { range, ...pkg } of advisory.ranges) {
        for (const name of names.filter((candidate) => takes(candidate, pkg))) {
          rows.set(`${name} ${advisory.ghsa} ${range}`, fromRepository(repo, name, advisory, range, asked.get(name), { covers, details }))
        }
      }
    }
  }
  return [...rows.values()]
}

// Each asked name's repository: as given, `known`, or else looked up,
// through `cache`.
async function reposOf(asked, known, lookUp, cache) {
  const found = await lookUp([...asked.keys()].filter((name) => !known.has(name)), { asked, cache })
  return (name) => known.get(name) ?? found.get(name)
}

// A maintainer's advisory is on the repository before GitHub reviews it
// into the databases the registries answer from. With `repoAdvisories`,
// each package's repository, `known` or else looked up, adds what it
// publishes for GitHub's `ecosystem` entries naming the package, for the
// versions `rows` do not already report under that GHSA.
export async function withRepositories(rows, asked, { github, repoAdvisories, known, details, cache }, { ecosystem, lookUp, covers }) {
  if (!repoAdvisories) return rows
  const reported = new Set(rows.flatMap((row) => [row.id, row.ghsa, ...row.aliases].filter(isGhsa).flatMap((id) => row.versions.map((version) => `${row.name} ${id} ${version}`))))
  const repoOf = await reposOf(asked, known, lookUp, cache)
  const takes = (name, pkg) => pkg.ecosystem === ecosystem && pkg.name === name
  const added = await repositoryAdvisories(github, asked, { repoOf, takes, covers, details, cache })
  return [...rows, ...added.map((row) => ({ ...row, versions: row.versions.filter((version) => !reported.has(`${row.name} ${row.id} ${version}`)) }))]
}

// stasis versions a repository with no version of its own by its branch,
// or 0.0.0: every range covers those.
const coversPlaceholder = (version, range) => version === '0.0.0' || mayBeInRange(version, range)

// Dependencies that are GitHub repositories themselves: every range their
// own published advisories list counts, whichever package it names.
export const GITHUB = {
  repositoryOnly: true,
  assertName: assertRepo,
  assertVersion: assertion('a version or a branch name', isRefName),
  advisories: (asked, { github, details, cache }) => repositoryAdvisories(github, asked, { repoOf: (repo) => repo, covers: coversPlaceholder, details, cache }),
}

// Soldeer packages, which no advisory database has: the repository each
// is published from, as given or else as Soldeer's project names it, is
// their only source, and every range its advisories list counts, whichever
// package it names (often the npm package the same release went out as).
export const SOLDEER = {
  repositoryOnly: true,
  assertName: assertSoldeerName,
  assertVersion: assertSoldeerVersion,
  advisories: async (asked, { github, known, details, cache }) => await repositoryAdvisories(github, asked, { repoOf: await reposOf(asked, known, soldeerRepos, cache), details, cache }),
}
