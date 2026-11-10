import assert from 'node:assert/strict'

import { isGhsa, isRepo, isStrings, matches, show } from '../args.js'
import { intersects, satisfies, valid, validRange } from '../semver.js'

export const order = (a, b) => (a > b) - (a < b)

// The repository's page for a GHSA where `repo` is given, else the database's.
export function advisoryUrl(ghsa, repo) {
  assert.ok(isGhsa(ghsa) && (repo === undefined || isRepo(repo)), `advisories: no GitHub advisory page for ${show(ghsa)} on ${show(repo)}`)
  return repo === undefined ? `https://github.com/advisories/${ghsa}` : `https://github.com/${repo}/security/advisories/${ghsa}`
}

// As `npm audit` matches: a prerelease is in a range around it.
const SEMVER = { includePrerelease: true, loose: true }

export const inRange = (version, range) => satisfies(version, range, SEMVER)

// A version semver can't read may be in any range.
export const mayBeInRange = (version, range) => valid(version) === null || inRange(version, range)

export const overlap = (a, b) => validRange(a, SEMVER) !== null && intersects(a, b, SEMVER)

// One set with no upper bound, as `>= 0` and `*` are.
const HIGHEST = `${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`
export const isOpenAbove = (range) => !range.includes('|') && inRange(HIGHEST, range)

// A range or version semver can't read covers every version: a missed
// advisory is worse than a spare one.
export const covered = (asked, range, covers = mayBeInRange) => (validRange(range, SEMVER) === null ? [...asked] : asked.filter((version) => covers(version, range)))

export const isText = (value) => typeof value === 'string' && value.isWellFormed()

export function detailsOf(text, id) {
  if (text == null || text === '') return {}
  assert.ok(isText(text), `advisories: malformed details in ${id}`)
  return { details: text }
}

// MAL- records, CWE-506 (how GitHub files malware), or "malware" in the
// title (@solana/web3.js's GHSA-jcxm-7wvp-g6p5 has only CWE-200).
export const isMalware = ({ id, aliases, cwe, title }) => [id, ...aliases].some((each) => each.startsWith('MAL-')) || cwe.includes('CWE-506') || /\bmalware\b/iu.test(title ?? '')

export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info']
const isCvssVector = matches(/^CVSS:[34]\.\d(?:\/[A-Z]{1,4}:[A-Z]{1,2})+$/u)
const isCwe = matches(/^CWE-\d{1,6}$/u)

// Each field only in its documented shape: GitHub's `medium` is `moderate`,
// and npm's unscored 0 no score.
export function metrics({ severity, score, vector, cwe }) {
  const word = typeof severity === 'string' ? severity.toLowerCase().replace(/^medium$/u, 'moderate') : undefined
  return {
    ...(SEVERITIES.includes(word) && { severity: word }),
    ...(typeof score === 'number' && score > 0 && score <= 10 && { cvss: score }),
    ...(isCvssVector(vector) && { cvssVector: vector }),
    cwe: isStrings(cwe) ? cwe.filter(isCwe) : [],
  }
}
