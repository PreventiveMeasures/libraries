import type { Client, RepoName } from './github.js'
import type { CacheStore } from './npm.js'

export { HttpError } from './npm.js'
export type { CacheStore } from './npm.js'

// As purl and stasis name them.
export type Ecosystem = 'npm' | 'cargo' | 'composer' | 'soldeer' | 'github'

export interface Package {
  ecosystem: Ecosystem
  // An npm package name, a crate name, a Composer `vendor/name`, a Soldeer
  // project name, or for `github`, the repository `owner/name` itself.
  name: string
  // Its GitHub repository, where the caller knows it (package.json,
  // Cargo.toml, installed.json), for `repoAdvisories` to ask without
  // looking it up, and for a `soldeer` package, to ask instead of the one
  // Soldeer names; not for `github` packages, which are their own.
  github?: RepoName
  // npm and `github`: semver; `github` also takes a branch name or 0.0.0,
  // which every range covers. cargo: semver, build metadata allowed.
  // composer: a release (`v1.2.3`, `1.2.3.4`, `2.0.0-RC1`), dev versions
  // refused; one semver cannot read is covered by every range. soldeer: as
  // soldeer.lock has it; one semver cannot read (a bare number, a commit)
  // is covered by every range.
  versions: string[]
}

export interface AdvisoryOptions {
  // The client every GitHub request goes through. Required for `soldeer`
  // and `github` packages, whose repository's published advisories are
  // their only source, and for `repoAdvisories`; by itself it asks nothing
  // else.
  github?: Client
  // Also asks each npm, cargo and composer package's GitHub repository
  // for its published advisories, which it has before GitHub reviews them
  // into the databases above: the package's `github` where given, else
  // the one looked up. An npm package's is the one the document of its
  // newest version asked names, kept for good as getMeta keeps it (none
  // where the registry does not have that version); a crate's and a
  // composer package's, the one crates.io or Packagist names, kept a
  // month. Needs `github`.
  repoAdvisories?: boolean
  // Where what this call caches is kept, as CacheOptions (npm.js) has it:
  // a repository's listing, and each package's repository looked up (an
  // npm package's as its version's document). See `advisories`.
  cache?: CacheStore | false
  // Also returns each advisory's full text, as `details`. OSV's records
  // and a repository's listing already carry it; npm's registry does not,
  // and its rows take OSV's record of their GHSA, one more request each
  // (no GitHub client needed).
  details?: boolean
  // Also asks OSV of each npm package's versions, as cargo and composer
  // packages always are, for what the registry does not have: above all
  // the malicious packages' records (MAL-...), which it has none of, as
  // those of npm releases taken down that GitHub's database has no
  // advisory of. A version a registry row reports under the same advisory,
  // its id among an OSV record's id and aliases, is left to that row,
  // which takes the record's ids among its aliases; the versions a record
  // of the row's own id covers beyond the registry's range join it too.
  // Sends each npm package's name and versions to OSV, so not for a
  // private package.
  osv?: boolean
}

// One advisory on one package, with the versions asked about that it
// covers (never empty): one row an id, however many of its sources answer
// it, or however often one does.
export interface Advisory {
  ecosystem: Ecosystem
  name: string
  // `registry`: npm's, as `npm audit` has it. `osv`: OSV's records for
  // cargo and composer, and with `osv` for npm, the versions they cover
  // that no registry row reports under the same advisory; RustSec's,
  // GitHub's and malicious packages' (MAL-...) among them; of the records
  // naming each other as aliases, directly or through others, a version is
  // reported under one only: RustSec's, else the GHSA, else the first by
  // id. Each has the others' ids among its aliases, and stays a row of its
  // own, as its source rates it.
  // `repository`: published on the package's repository, holding only the
  // versions the others' answer does not report under that GHSA. The only
  // source for `soldeer` and `github`, where every range counts, whichever
  // package it names.
  // An id answered more than once -- by npm's registry once a range, by
  // OSV's record of it or its repository for versions beyond the registry's
  // range, by its repository once a range -- is one row: the registry's,
  // else OSV's, else the repository's, with what it lacks of theirs (title,
  // details), the worst severity of them, the highest CVSS score with its
  // own vector, and all their ranges, CWEs and versions.
  source: 'registry' | 'osv' | 'repository'
  // A GHSA, RUSTSEC-..., MAL-..., DRUPAL-CORE-... or another OSV id, or
  // npm:<id> for a registry row without a GHSA.
  id: string
  // The id itself, or an OSV record's one GHSA alias.
  ghsa?: string
  // GitHub's page for the GHSA, with it: a `repository` row's on its
  // repository (https://github.com/owner/name/security/advisories/GHSA-...),
  // which has it before GitHub reviews it into its advisory database; any
  // other's in that database (https://github.com/advisories/GHSA-...). An
  // `osv` row without one has osv.dev's page for its record
  // (https://osv.dev/vulnerability/RUSTSEC-...). Built, never fetched: only
  // a registry row without a GHSA (npm:<id>) has none.
  url?: string
  // The advisory's other ids: an `osv` row's record's own and its group's,
  // and with `osv`, a registry row's OSV records' of it.
  aliases: string[]
  title?: string
  // With `details`, the advisory's full text, Markdown as published: an
  // OSV record's `details`, a repository advisory's `description`, or for
  // a registry row, OSV's record of its GHSA. Absent where there is none:
  // a registry row without a GHSA, or with one OSV does not have yet.
  details?: string
  // `critical`, `high`, `moderate`, `low`; GitHub's `medium` reads
  // `moderate`. RustSec has none.
  severity?: string
  // Absent where there is no score (npm spells that 0).
  cvss?: number
  cvssVector?: string
  cwe: string[]
  // As written: npm's syntax from the registry, GitHub's
  // (`>= 1.0.0, < 1.2.6`) from a repository; OSV's records have none. A
  // repository range semver cannot read, or none, covers every version.
  // Each range its id was answered with that covers an asked version,
  // joined by ` || `; none ('') where one is none. A version only OSV
  // reports may be outside it: hermes-engine's GHSA-f5x2-xv93-4p23 is
  // `<=0.4.3` on npm, the last version known affected, and fixed in 0.5.2
  // by OSV's record of it, which reports 0.5.0 too.
  range?: string
  // RustSec's kind for an advisory that is not a vulnerability as such:
  // `unmaintained`, `unsound`, `notice`. For an id answered more than once,
  // only where each answer gives it.
  informational?: string
  versions: string[]
}

// Every package, and every one of its versions, is checked against its
// ecosystem's rules before the first request; a name given twice is
// merged, and must not name two repositories. npm is asked 250 names a
// request, OSV 1000 versions, Soldeer one project, and with `details`, OSV
// one GHSA among npm's rows; a project Soldeer does not have or that names
// no GitHub repository, a repository gone or blocked, and one GitHub
// redirects anywhere but to a repository by its id, add nothing, and a
// GHSA OSV does not have adds no `details`. A repository renamed or
// transferred, which GitHub redirects to it by its id, is listed by the
// name it has now, as getRepo's `followRedirect` (github.js) finds it, its
// rows' `url` on it. Any other failure, a malformed answer, or one about
// something not asked, throws: nothing is left out quietly.
// A repository's listing is kept for 90 minutes, as one entry for every
// spelling of the name it is asked by, one renamed or transferred too,
// holding only what rows are made from, `details` included: in
// setCacheDir's cache gzipped, in a `cache` store as it is, or with
// `cache` false, nowhere. 90 minutes is how late an advisory its
// maintainer publishes can be seen. One gone or malformed is not kept.
// Sorted by ecosystem and name. Versions are matched by npm's semver, from
// the npm beside node, or by the semver peer where there is no npm.
export function advisories(packages: Iterable<Package>, options?: AdvisoryOptions): Promise<Advisory[]>
