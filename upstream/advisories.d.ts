// Hand-written against advisories.js; a change to either belongs with the
// other.
//
// Each function takes the installed packages as `{ name, version }` and
// checks every name and version against its ecosystem's rules before the
// first request. A failed request, or an answer that is malformed or
// about something not asked, throws; nothing is left out quietly.

export { HttpError } from './npm.js'

export interface InstalledPackage {
  name: string
  version: string
}

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
  cvssVector?: string
  cwe: string[]
  range: string
  // The versions asked about that `range` covers; never empty.
  versions: string[]
}

// One OSV record on one package, with the versions asked about that it
// affects (never empty).
export interface OsvAdvisory {
  name: string
  // RUSTSEC-…, GHSA-…, or another database's id (DRUPAL-CORE-…).
  id: string
  // The id itself, or its one GHSA alias; absent where there is none, or
  // more than one.
  ghsa?: string
  aliases: string[]
  title?: string
  // GitHub's word for a GHSA record; RustSec has none.
  severity?: string
  cvssVector?: string
  // RustSec's kind for an advisory that is not a vulnerability as such:
  // `unmaintained`, `unsound`, `notice`.
  informational?: string
  versions: string[]
}

// What `npm audit` asks the registry, 250 names to a request. Sorted by
// name. Matching versions to ranges takes npm's semver, from the npm
// beside node.
export function npmAdvisories(packages: Iterable<InstalledPackage>): Promise<NpmAdvisory[]>

// RustSec, the database `cargo audit` reads, through OSV. Versions are
// semver, build metadata allowed. Sorted by name, then id.
export function cargoAdvisories(packages: Iterable<InstalledPackage>): Promise<OsvAdvisory[]>

// OSV's Packagist records, mostly GHSA. A record another database also
// publishes under a GHSA answered for the same package is left out. Dev
// versions (`dev-main`) are refused: OSV cannot place them. Sorted by
// name, then id.
export function packagistAdvisories(packages: Iterable<InstalledPackage>): Promise<OsvAdvisory[]>
