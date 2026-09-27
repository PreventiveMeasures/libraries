// Hand-written against advisories.js; a change to either belongs with the
// other.
//
// Each function takes the installed packages as `{ name, version }` and
// checks every name and version against its ecosystem's rules before the
// first request. A failed request, or an answer that is malformed or
// about something not asked, throws; nothing is left out quietly.

import type { Client } from './github.js'

export { HttpError } from './npm.js'

export interface InstalledPackage {
  name: string
  version: string
}

// One advisory on one package, over one vulnerable range. An advisory is
// listed once per range, so a `ghsa` can appear more than once for a
// package, each time with its own `range` and `versions`.
export interface NpmAdvisory {
  name: string
  // `registry`: reviewed by GitHub, as `npm audit` has it. `repository`:
  // published by the maintainer and not in the registry's answer yet.
  source: 'registry' | 'repository'
  // The registry's id for this advisory and range; registry only.
  id?: number
  // Absent only where the registry's link is not a GitHub advisory page.
  ghsa?: string
  title: string
  // The registry's word, always there from it; `medium` reads `moderate`.
  severity?: string
  // Absent where the advisory has no score (the registry spells that 0).
  cvss?: number
  cvssVector?: string
  cwe: string[]
  // As written: npm's syntax from the registry, GitHub's
  // (`>= 1.0.0, < 1.2.6`) from a repository.
  range: string
  // The versions asked about that `range` covers; never empty. A
  // repository range semver cannot read, or none, covers them all.
  versions: string[]
}

// A row from a repository's own published advisories, as githubAdvisories
// answers them: `name` is the repository.
export type GitHubAdvisory = Omit<NpmAdvisory, 'id' | 'source'> & { source: 'repository' }

// One OSV record on one package, with the versions asked about that it
// affects (never empty).
export interface OsvAdvisory {
  name: string
  source: 'osv'
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

// What `npm audit` asks the registry, 250 names to a request. With
// `github`, also what each package's repository publishes that the
// registry did not answer with, which covers advisories GitHub has not
// reviewed yet: the repository is the one the registry names for the
// package (through resolvePackageRepos's cache), asked once, four at a
// time. A package the registry does not have or that names no GitHub
// repo, and a repository gone, renamed or blocked, add nothing; any other
// failure, a lookup's included, throws. Sorted by name, the registry's
// rows first. Versions are matched by npm's semver, from the npm beside
// node.
export function npmAdvisories(packages: Iterable<InstalledPackage>, options?: { github?: Client }): Promise<NpmAdvisory[]>

// RustSec, the database `cargo audit` reads, through OSV. Versions are
// semver, build metadata allowed. Sorted by name, then id.
export function cargoAdvisories(packages: Iterable<InstalledPackage>, options?: { github?: Client }): Promise<(OsvAdvisory | GitHubAdvisory)[]>

// OSV's Packagist records, mostly GHSA. A record another database also
// publishes under a GHSA answered for the same package is left out. Dev
// versions (`dev-main`) are refused: OSV cannot place them. Sorted by
// name, then id.
export function composerAdvisories(packages: Iterable<InstalledPackage>, options?: { github?: Client }): Promise<(OsvAdvisory | GitHubAdvisory)[]>

// Dependencies that are GitHub repositories themselves (stasis's `github`
// ecosystem): `name` is `owner/name`, `version` a version or, where stasis
// had none, a branch name or 0.0.0, which every range covers. Each
// repository's own published advisories, asked once, four at a time, with
// every range they list counted, whichever package it names; the same
// range listed for two packages is one row. A repository gone, renamed or
// blocked is skipped; any other failure throws. Sorted by name.
export function githubAdvisories(packages: Iterable<InstalledPackage>, options: { github: Client }): Promise<GitHubAdvisory[]>
