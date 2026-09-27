import { isStrings, matches } from '../args.js'
import { satisfies, validRange } from '../semver.js'

export const byNumbers = new Intl.Collator('en', { numeric: true }).compare
export const order = (a, b) => (a > b) - (a < b)

// As `npm audit` matches: a prerelease is in a range around it.
const SEMVER = { includePrerelease: true, loose: true }
export const inRange = (version, range) => satisfies(version, range, SEMVER)

// The asked versions a range `covers`. One semver cannot read covers them
// all: a missed advisory is worse than a spare one.
export const covered = (asked, range, covers = inRange) => (validRange(range, SEMVER) === null ? [...asked] : asked.filter((version) => covers(version, range)))

// Remote text, as long as it is well-formed; anything else is refused as
// malformed by whoever reads it.
export const isText = (value) => typeof value === 'string' && value.isWellFormed()

const SEVERITIES = new Set(['critical', 'high', 'moderate', 'low', 'info'])
const isCvssVector = matches(/^CVSS:[34]\.\d(?:\/[A-Z]{1,4}:[A-Z]{1,2})+$/u)
const isCwe = matches(/^CWE-\d{1,6}$/u)

// The fields every source may carry, kept only in the shape they are
// documented in: npm's severity words (GitHub's `medium` read `moderate`),
// a score in (0, 10] (npm spells "not scored" 0), a CVSS vector, CWE ids.
export function metrics({ severity, score, vector, cwe }) {
  const word = typeof severity === 'string' ? severity.toLowerCase().replace(/^medium$/u, 'moderate') : undefined
  return {
    ...(SEVERITIES.has(word) && { severity: word }),
    ...(typeof score === 'number' && score > 0 && score <= 10 && { cvss: score }),
    ...(isCvssVector(vector) && { cvssVector: vector }),
    cwe: isStrings(cwe) ? cwe.filter(isCwe) : [],
  }
}
