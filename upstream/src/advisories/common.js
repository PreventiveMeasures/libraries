import assert from 'node:assert/strict'

import { isGhsa, isRepo, isStrings, matches, show } from '../args.js'
import { satisfies, valid, validRange } from '../semver.js'

export const order = (a, b) => (a > b) - (a < b)

// GitHub's page for a GHSA: the advisory database's, which has every one
// the registry and OSV answer with, or the page of the `repo` that
// published it, which has it before GitHub reviews it into the database.
export function advisoryUrl(ghsa, repo) {
  assert.ok(isGhsa(ghsa) && (repo === undefined || isRepo(repo)), `advisories: no GitHub advisory page for ${show(ghsa)} on ${show(repo)}`)
  return repo === undefined ? `https://github.com/advisories/${ghsa}` : `https://github.com/${repo}/security/advisories/${ghsa}`
}

// As `npm audit` matches: a prerelease is in a range around it.
const SEMVER = { includePrerelease: true, loose: true }

export const inRange = (version, range) => satisfies(version, range, SEMVER)

// A version semver cannot read may be in any range. Whatever it reads is
// a version, `v1.2.3` and `1.2.3+build` included.
export const mayBeInRange = (version, range) => valid(version) === null || inRange(version, range)

// The asked versions a range `covers`. One semver cannot read, range or
// version, covers them all: a missed advisory is worse than a spare one.
export const covered = (asked, range, covers = mayBeInRange) => (validRange(range, SEMVER) === null ? [...asked] : asked.filter((version) => covers(version, range)))

// Remote text, as long as it is well-formed; anything else is refused as
// malformed by whoever reads it.
export const isText = (value) => typeof value === 'string' && value.isWellFormed()

// An advisory's full text, for `details`: none where its source has none,
// and refused where it is not well-formed.
export function detailsOf(text, id) {
  if (text == null || text === '') return {}
  assert.ok(isText(text), `advisories: malformed details in ${id}`)
  return { details: text }
}

// An advisory of malware, not a vulnerability in a package: one of OSV's
// records of malicious packages (MAL-...), its id or one of its aliases,
// as a registry row takes the ids of OSV's records of it; one filed under
// CWE-506, Embedded Malicious Code, as GitHub files its malware advisories,
// which the registry and OSV answer with (flatmap-stream's "Malicious
// Package", ua-parser-js's "Embedded malware", rated high); or one whose
// title says malware where its CWE doesn't (@solana/web3.js's
// GHSA-jcxm-7wvp-g6p5, CWE-200 alone), as triage's npmMalwareAdvisory
// takes it.
export const isMalware = ({ id, aliases, cwe, title }) => [id, ...aliases].some((each) => each.startsWith('MAL-')) || cwe.includes('CWE-506') || /\bmalware\b/iu.test(title ?? '')

export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info']
const isCvssVector = matches(/^CVSS:[34]\.\d(?:\/[A-Z]{1,4}:[A-Z]{1,2})+$/u)
const isCwe = matches(/^CWE-\d{1,6}$/u)

// The fields every source may carry, kept only in the shape they are
// documented in: npm's severity words (GitHub's `medium` read `moderate`),
// a score in (0, 10] (npm spells "not scored" 0), a CVSS vector, CWE ids.
export function metrics({ severity, score, vector, cwe }) {
  const word = typeof severity === 'string' ? severity.toLowerCase().replace(/^medium$/u, 'moderate') : undefined
  return {
    ...(SEVERITIES.includes(word) && { severity: word }),
    ...(typeof score === 'number' && score > 0 && score <= 10 && { cvss: score }),
    ...(isCvssVector(vector) && { cvssVector: vector }),
    cwe: isStrings(cwe) ? cwe.filter(isCwe) : [],
  }
}
