import type { Client, RepoName } from './github.js'
import type { CacheStore } from './npm.js'

export { HttpError } from './npm.js'
export type { CacheStore } from './npm.js'

// purl's package types, and `ruby` for Ruby interpreters.
export type Ecosystem = 'npm' | 'cargo' | 'composer' | 'gem' | 'ruby' | 'pypi' | 'swift' | 'cocoapods' | 'soldeer' | 'github'

export interface Package {
  ecosystem: Ecosystem
  // As its lockfile names it: a pod by its root (`Firebase`), a Swift package
  // by its repository in any case (`github.com/vapor/vapor`), a `github` package
  // by `owner/name` as GitHub spells it, a Ruby by its engine (`ruby`, `jruby`).
  name: string
  // Its repository, where known, so `repoAdvisories` needn't look it up.
  github?: RepoName
  // As its lockfile writes them, matched by the ecosystem's own rules: Ruby's as
  // Bundler writes it (`3.3.6p108`). A `github` package takes a tag (`v4` its
  // whole line), a branch or a commit; an unversioned Swift pin is refused.
  versions: string[]
  // A `github` package: false to ask its repository alone, its name sent to
  // no other source (OSV), as for one not everyone may read. Any spelling
  // saying so holds for all. Not for other ecosystems.
  external?: boolean
}

export interface AdvisoryOptions {
  // Required for `ruby`, `cocoapods`, `soldeer` and `github` packages and for
  // `repoAdvisories`. With it, gems are also checked against ruby-advisory-db.
  github?: Client
  // Also reads advisories each package's repository has published that
  // GitHub hasn't reviewed yet. Needs `github`.
  repoAdvisories?: boolean
  // Where lookups and listings are cached (see CacheOptions); false keeps none.
  cache?: CacheStore | false
  // Also returns each advisory's full text, as `details`.
  details?: boolean
  // Also asks OSV about public npm packages: malware and taken-down
  // releases, which npm's registry has no advisories of.
  osv?: boolean
}

// One advisory on one package, one row per id, however many sources have it.
export interface Advisory {
  ecosystem: Ecosystem
  name: string
  // npm's registry, OSV, Packagist, ruby-advisory-db, or the package's
  // repository (the only source for `cocoapods` and `soldeer`).
  source: 'registry' | 'osv' | 'packagist' | 'rubysec' | 'repository'
  // The GHSA where there is one, else its source's (RUSTSEC-..., PYSEC-...,
  // MAL-..., CVE-...), or npm:<id>.
  id: string
  ghsa?: string
  url?: string
  // Its other ids.
  aliases: string[]
  title?: string
  // With `details`: its full text, in Markdown.
  details?: string
  // `critical`, `high`, `moderate` or `low`.
  severity?: string
  cvss?: number
  cvssVector?: string
  cwe: string[]
  // The affected range as its source wrote it, where it has one.
  range?: string
  // RustSec's `unmaintained`, `unsound` or `notice`: not a vulnerability as
  // such. A yanked crate isn't an advisory: see cargo.js's yankedVersions.
  informational?: string
  // Malware, not a vulnerability.
  malware?: true
  // The asked versions it affects, never none.
  versions: string[]
}

// The advisories on the asked versions, sorted by ecosystem and name. Input
// is checked before any request; a failed or malformed answer throws rather
// than leaving anything out.
export function advisories(packages: Iterable<Package>, options?: AdvisoryOptions): Promise<Advisory[]>
