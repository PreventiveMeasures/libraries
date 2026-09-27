// Hand-written against advisories.js; a change to either belongs with the
// other.

import type { Client, RepoName } from './github.js'

export { HttpError } from './npm.js'

// As purl and stasis name them.
export type Ecosystem = 'npm' | 'cargo' | 'composer' | 'github'

export interface Package {
  ecosystem: Ecosystem
  // An npm package name, a crate name, a Composer `vendor/name`, or for
  // `github`, the repository `owner/name` itself.
  name: string
  // Its GitHub repository, where the caller knows it (package.json,
  // Cargo.toml, installed.json); not for `github` packages, which are
  // their own.
  github?: RepoName
  // npm and `github`: semver; `github` also takes a branch name or 0.0.0,
  // which every range covers. cargo: semver, build metadata allowed.
  // composer: a release (`v1.2.3`, `1.2.3.4`, `2.0.0-RC1`), dev versions
  // refused; one semver cannot read is covered by every range.
  versions: string[]
}

export interface AdvisoryOptions {
  // Asks the packages' GitHub repositories for their published advisories,
  // which they have before GitHub reviews them into the databases below.
  // Only repositories that are known are asked: a package's `github`, and
  // `github` packages. Required for `github` packages.
  github?: Client
  // Also looks every other package's repository up, from npm's metadata,
  // crates.io or Packagist, through the cache, and asks it too. Needs
  // `github`.
  lookUpRepos?: boolean
}

// One advisory on one package, with the versions asked about that it
// covers (never empty).
export interface Advisory {
  ecosystem: Ecosystem
  name: string
  // `registry`: npm's, as `npm audit` has it, one row per vulnerable
  // range. `osv`: RustSec for cargo, OSV's Packagist records for composer.
  // `repository`: published on the package's repository and not in the
  // others' answer, one row per range.
  source: 'registry' | 'osv' | 'repository'
  // A GHSA, RUSTSEC-…, DRUPAL-CORE-…, or npm:<id> for a registry row
  // without a GHSA.
  id: string
  // The id itself, or an OSV record's one GHSA alias.
  ghsa?: string
  aliases: string[]
  title?: string
  // `critical`, `high`, `moderate`, `low`; GitHub's `medium` reads
  // `moderate`. RustSec has none.
  severity?: string
  // Absent where there is no score (npm spells that 0).
  cvss?: number
  cvssVector?: string
  cwe: string[]
  // As written: npm's syntax from the registry, GitHub's
  // (`>= 1.0.0, < 1.2.6`) from a repository; OSV rows have none. A
  // repository range semver cannot read, or none, covers every version.
  range?: string
  // RustSec's kind for an advisory that is not a vulnerability as such:
  // `unmaintained`, `unsound`, `notice`.
  informational?: string
  versions: string[]
}

// Every package, and every one of its versions, is checked against its
// ecosystem's rules before the first request; a name given twice is
// merged, and must not name two repositories. npm is asked 250 names a
// request, OSV 1000 versions; a repository gone, renamed or blocked adds
// nothing. Any other failure, a malformed answer, or one about something
// not asked, throws: nothing is left out quietly. Sorted by ecosystem and
// name. Versions are matched by npm's semver, from the npm beside node.
export function advisories(packages: Iterable<Package>, options?: AdvisoryOptions): Promise<Advisory[]>
