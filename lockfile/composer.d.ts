// Reads a composer.lock, as Composer 2.0 to 2.10 write it. Throws a
// TypeError for bad arguments, and a LockfileError for anything Composer
// would not write as it is, or would not install from as it says:
//
// - The text other than as json_encode writes it, pretty, in the
//   indentation of the file, LF or CRLF line ends throughout: a key twice,
//   `{}` where Composer writes `[]`, a number written otherwise.
// - A field Composer does not write, one out of its order, or one it would
//   write back otherwise: a string where it writes a list, an empty one, a
//   type not in lowercase, keys or keywords unsorted.
// - A name Composer 2.10 refuses to install, a version or a constraint it
//   does not read, a source or a dist it has no downloader for, a URL or a
//   reference a tool would take for an option, a sha1 not in lowercase hex,
//   a bin out of the package, an absolute path.
// - Packages out of Composer's order, an alias of none, or not of the
//   version locked.
// - What `composer install` refuses before it installs, the platform left
//   aside: a package of a stability the lockfile does not take, a conflict
//   that a package meets, two packages of one name or of a name one
//   replaces; and, with composerJson, a requirement nothing meets, or that
//   nothing in `packages` meets of a package there, and a requirement of
//   the root's the lockfile does not meet.
// - Composer 1's lockfile, of plugin-api-version 1.x or none, or with
//   `packages-dev` null.
//
// Without composerJson, a requirement nothing in the lockfile meets is let
// be, as the root may provide or replace it, which the lockfile does not
// say. The platform is not read: each requirement on PHP, an extension or
// a library is left to the caller.
export function parseComposerLock(text: string, options?: ComposerOptions): ComposerLockfile

export interface ComposerOptions {
  // The text of the project's composer.json, which Composer reads beside
  // the lockfile: its name, the version it gives, if any, and what it
  // requires, conflicts with, provides and replaces, which Composer holds
  // the lockfile to. A version it does not give, Composer guesses from git;
  // here, any meets a constraint on it. Its content-hash is compared, as
  // `fresh`. Throws a LockfileError, of `where` composerJson, for one
  // Composer refuses to load by what is read or hashed of it here, as
  // Composer 2.10's schema and its loader take it; of a package
  // repository's package, only its name and version are checked, and
  // what is not hashed, `autoload`, `scripts`, `config` but its platform,
  // is not read.
  composerJson?: string
}

// `where` is a property path into the lockfile, `packages[3].dist.url`, or
// into composer.json, `composerJson.require["psr/log"]`; undefined for a
// syntax error of the lockfile, whose message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Each Record has a null prototype, and keeps the order of the lockfile but
// for a key that reads as an integer, which JavaScript puts first.

export type Stability = 'stable' | 'RC' | 'beta' | 'alpha' | 'dev'

// What Composer only passes on, as the package has it: a JSON object or
// array, never empty, with nothing in it Composer writes back otherwise.
export type ComposerJson = Record<string, unknown> | unknown[]

export interface ComposerLockfile {
  // The md5 of what composer.json asks for, which Composer checks the
  // lockfile is fresh by.
  contentHash: string
  // With composerJson, whether contentHash is its: where not, Composer
  // warns that the lockfile is out of date, and installs from it all the
  // same. Undefined without.
  fresh: boolean | undefined
  // Of the Composer that wrote it: 2.0.0, 2.1.0, 2.2.0, 2.3.0 of 2.3 to
  // 2.5, 2.6.0 of 2.6 to 2.8, 2.9.0 of 2.9 and 2.10.
  pluginApiVersion: string
  minimumStability: Stability
  // By name: what the root asks of each it names with a stability, as
  // `dev-main` or `^7.0@beta`.
  stabilityFlags: Record<string, Stability>
  preferStable: boolean
  preferLowest: boolean
  // What the root asks of the platform, by name, as constraints: in
  // require, and in require-dev.
  platform: Record<string, string>
  platformDev: Record<string, string>
  // config.platform when locked, which composer install takes in its place:
  // the version each platform package is taken to be at, or false for one
  // taken to be missing, but php.
  platformOverrides: Record<string, string | false>
  // The root's `x as y` of each package it asks for so, in require and in
  // require-dev alike, by package.
  aliases: ComposerRootAlias[]
  // By name, in lowercase as Composer goes by it: of `packages` in their
  // order, then of `packages-dev`, which `composer install --no-dev`
  // leaves out.
  packages: Record<string, ComposerPackage>
}

export interface ComposerRootAlias {
  // A key of `packages`.
  package: string
  // The version the root aliased, normalized, 9999999-dev of dev-master,
  // dev-trunk and dev-default: the package's, or its branch alias's.
  // Composer aliases the package so whatever it is.
  version: string
  alias: string
  aliasNormalized: string
}

export interface ComposerPackage {
  // As the package has it, which Composer installs into vendor/<name>.
  name: string
  // As locked, `v1.2.3`, `dev-main`, `1.0.x-dev`; and as Composer
  // normalizes it, `1.2.3.0`, `dev-main`, `1.0.9999999.9999999-dev`.
  version: string
  normalized: string
  stability: Stability
  // Of `packages-dev`.
  dev: boolean
  // The versions it goes by besides its own, which a constraint may meet:
  // its branch alias, of extra's branch-alias or 9999999-dev of a default
  // branch, and the root's.
  aliases: { version: string, normalized: string, root: boolean }[]
  // What it is cloned from, and what it is installed from by default.
  source: ComposerSource | undefined
  dist: ComposerDist | undefined
  // By name in lowercase: each requirement as written, and what meets it.
  require: Record<string, ComposerRequire>
  // By name in lowercase, constraints as written; `self.version` is the
  // package's own.
  conflict: Record<string, string>
  provide: Record<string, string>
  replace: Record<string, string>
  // The package's own dev requirements, which Composer never installs.
  requireDev: Record<string, string>
  // By name as written: why.
  suggest: Record<string, string>
  defaultBranch: boolean
  // Paths in the package, which Composer links into vendor/bin.
  bin: string[]
  // `library` and the like, in lowercase, which picks the installer.
  type: string
  // Under the package's directory, where PSR-0 code goes.
  targetDir: string | undefined
  extra: ComposerJson | undefined
  autoload: ComposerJson | undefined
  autoloadDev: ComposerJson | undefined
  // An http(s) URL Composer posts each install to.
  notificationUrl: string | undefined
  includePath: string[]
  phpExt: ComposerJson | undefined
  archive: { name: string | undefined, exclude: string[] }
  // By event: what the package runs on it, which Composer does of the
  // root's alone.
  scripts: Record<string, string[]>
  license: string[]
  authors: ComposerJson | undefined
  description: string | undefined
  homepage: string | undefined
  keywords: string[]
  support: ComposerJson | undefined
  funding: ComposerJson | undefined
  // true, or the name of the package to use instead.
  abandoned: string | true | undefined
  // The repository's, for its downloader: a path repository's `relative`
  // and `symlink`, an HTTP one's options.
  transportOptions: ComposerJson | undefined
  // DATE_RFC3339, `2026-08-24T09:21:06+00:00`.
  time: string | undefined
}

export interface ComposerRequire {
  constraint: string
  // PHP, an extension, a library or Composer's own API, which the platform
  // meets; the lockfile may have a package that provides it too.
  platform: boolean
  // Keys of `packages`: each that meets it, by its name, an alias, a provide
  // or a replace, of those installed with the package that asks, which for
  // one of `packages` are of `packages` alone. None for the platform's,
  // where no package provides it; and none where the root meets it, as
  // composerJson says, or, without it, may.
  targets: string[]
}

// `url` is a URL the type's tool fetches from, git's `user@host:path`, or a
// path from the lockfile's directory, `./` before it or not; a Perforce
// source's is its P4PORT. `reference` is a git source's commit, or a branch
// or tag name for one defined inline, and anything else its tool takes of
// the others.
export interface ComposerSource {
  type: 'git' | 'hg' | 'svn' | 'fossil' | 'perforce'
  url: string
  reference: string
  mirrors: ComposerMirror[]
}

// An archive by an http(s) URL or a path, or a directory by a path, from
// the lockfile's directory. `shasum` is a sha1 in lowercase hex, which
// Composer holds the archive to; undefined where none, as of GitHub's.
export interface ComposerDist {
  type: 'zip' | 'tar' | 'gzip' | 'xz' | 'rar' | 'phar' | 'file' | 'path'
  url: string
  reference: string | undefined
  shasum: string | undefined
  mirrors: ComposerMirror[]
}

// A URL Composer tries before the package's own, where preferred, or
// after, held to what that URL is: a dist's with %package%, %version%,
// %prettyVersion%, %reference% and %type% filled in, a git or hg source's
// with %package%, %normalizedUrl% and %type%. Composer tries no other
// source's.
export interface ComposerMirror {
  url: string
  preferred: boolean
}
