import assert from 'node:assert/strict'

import { assertRepo, assertion, isGhsa, isRefName, isStrings } from '../args.js'
import { isGone } from '../github/client.js'
import { recover } from '../http.js'
import { pool } from '../pool.js'
import { valid } from '../semver.js'
import { covered, inRange, isText, metrics } from './common.js'

const REPOS_AT_ONCE = 4

const isRepoAdvisory = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa_id)
  && advisory.state === 'published' && isText(advisory.summary)
  && (advisory.vulnerabilities == null || Array.isArray(advisory.vulnerabilities)) && (advisory.cwe_ids == null || isStrings(advisory.cwe_ids))

export const assertClient = assertion('a GitHub client from createClient', (value) => typeof value?.listRepoAdvisories === 'function')

const listAdvisories = (github, repo) => github.listRepoAdvisories({ repo }).catch(recover(isGone, []))

// GitHub's `>= 1.0.0, < 1.2.6` is npm's with the commas dropped.
// Maintainers write these unreviewed: one without a range, or with one
// semver cannot read, covers every version.
function fromRepository(name, advisory, range, asked, covers) {
  const cvss = [advisory.cvss_severities?.cvss_v3, advisory.cvss_severities?.cvss_v4, advisory.cvss].find((entry) => typeof entry?.vector_string === 'string')
  return {
    name,
    source: 'repository',
    id: advisory.ghsa_id,
    ghsa: advisory.ghsa_id,
    aliases: [],
    title: advisory.summary,
    ...metrics({ severity: advisory.severity, score: cvss?.score, vector: cvss?.vector_string, cwe: advisory.cwe_ids }),
    range,
    versions: covered(asked, range.replaceAll(',', ' '), covers),
  }
}

// Each asked name's repository, `repoOf` it, is asked once, and its
// advisories' vulnerable ranges become rows for the names that `takes` a
// vulnerability, one per name, advisory and range, holding the asked
// versions it `covers`.
async function repositoryAdvisories(github, asked, { repoOf, takes = () => true, covers }) {
  // GitHub's names are case-insensitive: one spelling asks for all.
  const namesOf = Map.groupBy([...asked.keys()].filter(repoOf), (name) => repoOf(name).toLowerCase())
  const listed = await pool([...namesOf.values()], REPOS_AT_ONCE, async (names) => ({ repo: repoOf(names[0]), names, list: await listAdvisories(github, repoOf(names[0])) }))
  const rows = new Map()
  for (const { repo, names, list } of listed) {
    for (const advisory of list) {
      assert.ok(isRepoAdvisory(advisory), `advisories: malformed advisory from ${repo}`)
      for (const vulnerability of advisory.withdrawn_at ? [] : advisory.vulnerabilities ?? []) {
        const range = vulnerability?.vulnerable_version_range ?? ''
        assert.ok(typeof range === 'string', `advisories: malformed range in ${advisory.ghsa_id}`)
        for (const name of names.filter((candidate) => takes(candidate, vulnerability?.package))) {
          rows.set(`${name} ${advisory.ghsa_id} ${range}`, fromRepository(name, advisory, range, asked.get(name), covers))
        }
      }
    }
  }
  return [...rows.values()]
}

// A maintainer's advisory is on the repository before GitHub reviews it
// into the databases the registries answer from. With `repoAdvisories`,
// each package's repository, `known` or else looked up, adds what it
// publishes for GitHub's `ecosystem` entries naming the package, for the
// versions `rows` do not already report under that GHSA.
export async function withRepositories(rows, asked, { github, repoAdvisories, known }, { ecosystem, lookUp, covers }) {
  if (!repoAdvisories) return rows
  const reported = new Set(rows.flatMap((row) => [row.id, row.ghsa, ...row.aliases].filter(isGhsa).flatMap((id) => row.versions.map((version) => `${row.name} ${id} ${version}`))))
  const found = await lookUp([...asked.keys()].filter((name) => !known.has(name)))
  const repoOf = (name) => known.get(name) ?? found.get(name)
  const takes = (name, pkg) => pkg?.ecosystem === ecosystem && pkg.name === name
  const added = await repositoryAdvisories(github, asked, { repoOf, takes, covers })
  return [...rows, ...added.map((row) => ({ ...row, versions: row.versions.filter((version) => !reported.has(`${row.name} ${row.id} ${version}`)) }))]
}

// stasis versions a repository with no version of its own by its branch,
// or 0.0.0: every range covers those. Whatever semver reads is a version,
// `v1.2.3` and `1.2.3+build` included.
const coversPlaceholder = (version, range) => version === '0.0.0' || valid(version) === null || inRange(version, range)

// Dependencies that are GitHub repositories themselves: every range their
// own published advisories list counts, whichever package it names.
export const GITHUB = {
  assertName: assertRepo,
  assertVersion: assertion('a version or a branch name', isRefName),
  advisories: (asked, { github }) => repositoryAdvisories(github, asked, { repoOf: (repo) => repo, covers: coversPlaceholder }),
}
