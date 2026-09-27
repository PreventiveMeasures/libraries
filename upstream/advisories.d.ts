// Hand-written against advisories.js; a change to either belongs with the
// other.

export { HttpError } from './npm.js'

// One advisory on one package, over one vulnerable range. The registry
// lists an advisory once per range, so a `ghsa` can appear more than once
// for a package, each time with its own `range` and `versions`.
export interface NpmAdvisory {
  name: string
  // The registry's id for this advisory and range.
  id: number
  // Absent only where the registry's link is not a GitHub advisory page.
  ghsa?: string
  title: string
  severity: string
  // Absent where the advisory has no score (the registry spells that 0).
  cvss?: number
  cwe: string[]
  range: string
  // The versions asked about that `range` covers; never empty.
  versions: string[]
}

// The registry's advisories for the given installed versions, asked as
// `npm audit` asks, 250 names to a request, and sorted by name. Names and
// versions are checked before the first request; a failed request, or an
// answer about a name not asked or with a malformed advisory, throws.
// Matching versions to ranges takes npm's semver, from the npm beside node.
export function npmAdvisories(packages: Iterable<{ name: string; version: string }>): Promise<NpmAdvisory[]>
