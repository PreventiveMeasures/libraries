import assert from 'node:assert/strict'

import { assertPodName, assertPodVersion, assertRepo, assertSoldeerName, assertSoldeerVersion, assertion, isGhsa, isRefName, isRepo, isStrings } from '../args.js'
import { readRecord, writeRecord } from '../cache.js'
import { isGone } from '../github/client.js'
import { HttpError, recover } from '../http.js'
import { pool } from '../pool.js'
import { boundRange, compareVersions, readRange } from '../rubygems/version.js'
import { isExactVersion } from '../semver.js'
import { advisoryUrl, covered, detailsOf, isOpenAbove, isText, mayBeInRange, metrics, order, overlap } from './common.js'
import { podRepos, soldeerRepos } from './repos.js'

const REPOS_AT_ONCE = 4
const DIR = 'github/advisories'
// Not a month: a maintainer's advisory is wanted before GitHub reviews it.
const LISTING_TTL_MS = 90 * 60 * 1000
// Raised when a listing is kept differently.
const VERSION = 3

const isRepoAdvisory = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa_id)
  && advisory.state === 'published' && isText(advisory.summary)
  && (advisory.vulnerabilities == null || Array.isArray(advisory.vulnerabilities)) && (advisory.cwe_ids == null || isStrings(advisory.cwe_ids))

export const assertClient = assertion('a GitHub client from createClient', (value) => typeof value?.listRepoAdvisories === 'function' && typeof value.getRepo === 'function')

// A range with no upper bound ends below its one patched version, where
// that leaves some of it; any other is as given.
function boundedRange(range, patched) {
  if (!isExactVersion(patched)) return range
  if (range.trim() === '') return `< ${patched}`
  const npm = range.replaceAll(',', ' ')
  return isOpenAbove(npm) && overlap(npm, `< ${patched}`) ? `${range.trim()}, < ${patched}` : range
}

// What is kept of a listing. One whose only fault is a description is
// answered but not kept.
function digest(repo, list) {
  return list.flatMap((advisory) => {
    assert.ok(isRepoAdvisory(advisory), `advisories: malformed advisory from ${repo}`)
    if (advisory.withdrawn_at) return []
    const cvss = [advisory.cvss_severities?.cvss_v3, advisory.cvss_severities?.cvss_v4, advisory.cvss].find((entry) => typeof entry?.vector_string === 'string')
    const ranges = (advisory.vulnerabilities ?? []).map((vulnerability) => {
      const range = vulnerability?.vulnerable_version_range ?? ''
      assert.ok(typeof range === 'string', `advisories: malformed range in ${advisory.ghsa_id}`)
      const { ecosystem, name } = vulnerability?.package ?? {}
      const patched = vulnerability?.patched_versions
      return { range, ...(typeof patched === 'string' && { patched: patched.trim() }), ...(typeof ecosystem === 'string' && { ecosystem }), ...(typeof name === 'string' && { name }) }
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

const isDigest = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa) && isText(advisory.title)
  && (advisory.description === undefined || isText(advisory.description))
  && Array.isArray(advisory.ranges) && advisory.ranges.every((entry) => typeof entry?.range === 'string' && (entry.patched === undefined || typeof entry.patched === 'string'))

// A renamed or transferred repository redirects; getRepo follows it.
const isRedirect = (err) => err instanceof HttpError && err.status >= 300 && err.status < 400

async function listingOf(github, repo) {
  try {
    return { repo, list: await github.listRepoAdvisories({ repo }) }
  } catch (err) {
    if (!isRedirect(err)) throw err
  }
  const moved = (await github.getRepo({ repo, followRedirect: true })).full_name
  return { repo: moved, list: await github.listRepoAdvisories({ repo: moved }) }
}

// A repository's listing and the name it has now, one cache entry for every
// spelling; none for one gone, blocked or redirected elsewhere, and not kept.
async function listAdvisories(github, repo, cache) {
  const name = repo.toLowerCase()
  const entry = await readRecord(DIR, name, cache, LISTING_TTL_MS)
  if (entry?.v === VERSION && (entry.repo === undefined || isRepo(entry.repo)) && Array.isArray(entry.advisories) && entry.advisories.every(isDigest)) {
    return { repo: entry.repo ?? repo, advisories: entry.advisories }
  }
  const found = await listingOf(github, repo).catch(recover((err) => isGone(err) || isRedirect(err), null))
  if (found === null) return { repo, advisories: [] }
  const advisories = digest(found.repo, found.list)
  if (advisories.every(isDigest)) await writeRecord(DIR, name, { v: VERSION, ...(found.repo !== repo && { repo: found.repo }), advisories }, cache)
  return { repo: found.repo, advisories }
}

// GitHub's `>= 1.0.0, < 1.2.6` is npm's without the commas. One semver
// can't read, or none, covers every version.
export const bySemver = (covers) => (asked, range) => covered(asked, range.replaceAll(',', ' '), covers)

function fromRepository(repo, name, advisory, range, versions, details) {
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
    versions,
  }
}

// A row per advisory, range and asked name `takes` it for.
async function repositoryAdvisories(github, asked, { repoOf, takes = () => true, versionsIn = bySemver(), bound = boundedRange, details, cache }) {
  const namesOf = Map.groupBy([...asked.keys()].filter(repoOf), (name) => repoOf(name).toLowerCase())
  const listed = await pool([...namesOf.values()], REPOS_AT_ONCE, async (names) => ({ names, ...(await listAdvisories(github, repoOf(names[0]), cache)) }))
  const rows = new Map()
  for (const { repo, names, advisories } of listed) {
    for (const advisory of advisories) {
      for (const { range: given, patched, ...pkg } of advisory.ranges) {
        const range = bound(given, patched)
        for (const name of names.filter((candidate) => takes(candidate, pkg))) {
          rows.set(`${name} ${advisory.ghsa} ${range}`, fromRepository(repo, name, advisory, range, versionsIn(asked.get(name), range), details))
        }
      }
    }
  }
  return [...rows.values()]
}

async function reposOf(asked, known, lookUp, cache) {
  const found = await lookUp([...asked.keys()].filter((name) => !known.has(name)), { asked, cache })
  return (name) => known.get(name) ?? found.get(name)
}

// With `repoAdvisories`, what each package's repository publishes for it,
// in versions `rows` don't already report under that GHSA.
export async function withRepositories(rows, asked, { github, repoAdvisories, known, details, cache }, { github: ecosystem, lookUp, versionsIn, bound, nameKey = (name) => name }) {
  if (!repoAdvisories) return rows
  const reported = new Set(rows.flatMap((row) => [row.id, row.ghsa, ...row.aliases].filter(isGhsa).flatMap((id) => row.versions.map((version) => `${row.name} ${id} ${version}`))))
  const repoOf = await reposOf(asked, known, lookUp, cache)
  const takes = (name, pkg) => pkg.ecosystem === ecosystem && typeof pkg.name === 'string' && nameKey(pkg.name) === nameKey(name)
  const added = await repositoryAdvisories(github, asked, { repoOf, takes, versionsIn, bound, details, cache })
  return [...rows, ...added.map((row) => ({ ...row, versions: row.versions.filter((version) => !reported.has(`${row.name} ${row.id} ${version}`)) }))]
}

// stasis versions a repository without versions by its branch, or 0.0.0:
// every range covers those.
const coversPlaceholder = (version, range) => version === '0.0.0' || mayBeInRange(version, range)

// GitHub repositories as dependencies: every range their advisories list
// counts, whichever package it names.
export const GITHUB = {
  repositoryOnly: true,
  assertName: assertRepo,
  nameKey: (repo) => repo.toLowerCase(),
  assertVersion: assertion('a version or a branch name', isRefName),
  advisories: (asked, { github, details, cache }) => repositoryAdvisories(github, asked, { repoOf: (repo) => repo, versionsIn: bySemver(coversPlaceholder), details, cache }),
}

// No database has Soldeer packages: their repository's advisories are the
// only source, every range counting.
export const SOLDEER = {
  repositoryOnly: true,
  assertName: assertSoldeerName,
  assertVersion: assertSoldeerVersion,
  advisories: async (asked, { github, known, details, cache }) => await repositoryAdvisories(github, asked, { repoOf: await reposOf(asked, known, soldeerRepos, cache), details, cache }),
}

// Pod::Version is a Gem::Version, ordered without build metadata.
const podRelease = (version) => version.split('+')[0]

// A range Gem::Requirement can't read covers every version.
function podsIn(versions, range) {
  const test = readRange(range)
  return test === undefined ? [...versions] : versions.filter((version) => test(podRelease(version)))
}

// No database has pods: the repository their podspec names is the only
// source, every range counting.
export const COCOAPODS = {
  repositoryOnly: true,
  assertName: assertPodName,
  assertVersion: assertPodVersion,
  compare: (a, b) => compareVersions(podRelease(a), podRelease(b)) || order(a, b),
  advisories: async (asked, { github, known, details, cache }) => await repositoryAdvisories(github, asked, { repoOf: await reposOf(asked, known, podRepos, cache), versionsIn: podsIn, bound: boundRange, details, cache }),
}
