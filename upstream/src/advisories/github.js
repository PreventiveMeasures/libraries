import assert from 'node:assert/strict'

import { assertArgs, assertPackageVersion, assertRepo, assertion, isGhsa, isStrings } from '../args.js'
import { isGone } from '../github/client.js'
import { pool } from '../pool.js'
import { compareVersions, satisfies, validRange } from '../semver.js'
import { askedVersions, order } from './common.js'

const REPOS_AT_ONCE = 4

const isRepoAdvisory = (advisory) => advisory && typeof advisory === 'object' && isGhsa(advisory.ghsa_id)
  && advisory.state === 'published' && typeof advisory.summary === 'string'
  && (advisory.vulnerabilities == null || Array.isArray(advisory.vulnerabilities)) && (advisory.cwe_ids == null || isStrings(advisory.cwe_ids))
export const assertClient = assertion('a GitHub client from createClient', (value) => typeof value?.listRepoAdvisories === 'function')

const listAdvisories = (github, repo) => github.listRepoAdvisories({ repo }).catch((err) => {
  if (isGone(err)) return []
  throw err
})

// GitHub's `>= 1.0.0, < 1.2.6` is npm's with the commas dropped. A range
// semver cannot read covers every version: maintainers write these
// unreviewed, and a missed advisory is worse than a spare one.
function fromRepository(name, advisory, range, asked) {
  const npmRange = (range ?? '').replaceAll(',', ' ')
  const readable = validRange(npmRange) !== null
  const cvss = [advisory.cvss_severities?.cvss_v3, advisory.cvss_severities?.cvss_v4, advisory.cvss].find((entry) => typeof entry?.vector_string === 'string')
  const { severity } = advisory
  return {
    name,
    source: 'repository',
    ghsa: advisory.ghsa_id,
    title: advisory.summary,
    ...(typeof severity === 'string' && { severity: severity === 'medium' ? 'moderate' : severity }),
    ...(typeof cvss?.score === 'number' && cvss.score > 0 && { cvss: cvss.score }),
    ...(cvss && { cvssVector: cvss.vector_string }),
    cwe: advisory.cwe_ids ?? [],
    range: range ?? '',
    versions: asked.filter((version) => !readable || satisfies(version, npmRange)),
  }
}

// A maintainer's advisory is on the repository before GitHub reviews it
// into the database the registries answer from. Each repository in
// `namesOf` is asked once, and its advisories' vulnerable ranges become
// rows for those of its names that `takes` a vulnerability for, one per
// name, advisory and range.
export async function repositoryAdvisories(method, github, namesOf, asked, takes) {
  const listed = await pool([...namesOf], REPOS_AT_ONCE, async ([repo, names]) => ({ repo, names, list: await listAdvisories(github, repo) }))
  const rows = new Map()
  for (const { repo, names, list } of listed) {
    for (const advisory of list) assert.ok(isRepoAdvisory(advisory), `${method}: malformed advisory from ${repo}`)
    const vulnerable = list.filter((advisory) => !advisory.withdrawn_at).flatMap((advisory) => (advisory.vulnerabilities ?? []).map((vulnerability) => ({ advisory, vulnerability })))
    for (const { advisory, vulnerability } of vulnerable) {
      const range = vulnerability?.vulnerable_version_range
      assert.ok(range == null || typeof range === 'string', `${method}: malformed range in ${advisory.ghsa_id}`)
      for (const name of names.filter((candidate) => takes(candidate, vulnerability?.package, advisory))) {
        rows.set(`${name} ${advisory.ghsa_id} ${range}`, fromRepository(name, advisory, range, asked.get(name)))
      }
    }
  }
  return [...rows.values()]
}

// Dependencies that are GitHub repositories themselves (stasis's `github`
// ecosystem), `owner/name` at a semver version: every range their own
// published advisories list counts, whichever package it names.
export async function githubAdvisories(packages, options) {
  const asked = askedVersions('githubAdvisories', packages, assertRepo, assertPackageVersion, compareVersions)
  assertArgs('githubAdvisories', options, { github: assertClient })
  const namesOf = new Map([...asked.keys()].map((repo) => [repo, [repo]]))
  const advisories = await repositoryAdvisories('githubAdvisories', options.github, namesOf, asked, () => true)
  return advisories.filter((advisory) => advisory.versions.length > 0).toSorted((a, b) => order(a.name, b.name))
}
