// Hand-written against bundler.js; a change to either belongs with the other.

export { LockfileError } from './pnpm.js'

// Reads a Gemfile.lock, or a gems.locked, as Bundler 2.2 to 4.0 write it.
// Throws a TypeError for anything but a string, and a LockfileError for
// anything else Bundler would not write, or would read otherwise: `where`
// is a property path into the result, `specs["rack-session-2.1.2"]
// .dependencies.rack`, or undefined for the layout, whose message has the
// line, and for the file as a whole.
//
// Refused: a line, a section or an option Bundler does not write, or not
// where it writes it, which Bundler's own reader would skip or read as
// something else, and an option's value with a space at an end; a gem name
// RubyGems does not take, a version or a platform not in the form RubyGems
// writes it in, a requirement not as Bundler writes it; anything out of
// the order Bundler sorts it in, or listed twice; a plugin source; a GEM
// source of two remotes, either of which Bundler may fetch a gem from, or
// of none, which takes it from the gems installed where Bundler runs; a
// directory by an absolute path; a git source without the full commit it
// resolved to, or a `ref` of a full commit that is another one; a
// dependency of a gem that names no gem locked, or a requirement any gem
// locked under its name does not meet, as a lockfile edited by hand may
// have; a gem nothing depends on; one name from two sources, or two gems
// of one name for one platform, or a gem of a platform no platform of
// PLATFORMS takes, of its OS, CPU and libc; what the Gemfile asks for without its `!`
// from other than one default source, a git one never; a checksum
// not sha256 in lowercase hex, of a gem from a git or a path source, or of
// no gem, and a gem without its line in CHECKSUMS.
export function parseGemfileLock(text: string): GemfileLock

// Every Record has a null prototype, and is in the order the file has it.

export interface GemfileLock {
  // As Bundler writes them: the git and path sources, then the GEM ones,
  // of which there is one always, the Gemfile's own.
  sources: BundlerSource[]
  // By full name, as RubyGems names a gem's file: `name-version`, or
  // `name-version-platform` for a platform's own.
  specs: Record<string, BundlerSpec>
  // By name: the keys of `specs` locked under it, one for each platform
  // Bundler locked it for, all from one source.
  gems: Record<string, string[]>
  // Sorted; `ruby` where the gems of no platform are locked as such. Each
  // gem of a platform is one of them takes: `x86_64-linux-gnu`, say, of
  // `x86_64-linux`, not `x86_64-linux-musl`, or `arm64-darwin` of
  // `arm64-darwin-23`.
  platforms: string[]
  // What the Gemfile asks for, by name. One for a platform not locked, as
  // `platforms: [:jruby]` is with no Java platform, has no gem.
  dependencies: Record<string, BundlerDependency>
  // Whether there is a CHECKSUMS section, which Bundler 2.6 and later
  // write where asked, and 4.0 for a new lockfile: Bundler then checks
  // each gem it fetches against its checksum there.
  checksums: boolean
  // Of CHECKSUMS, Bundler's own gem, at the version it was locked with,
  // which Bundler 4 writes.
  bundlerChecksum: { version: string, checksum: string } | undefined
  // RUBY VERSION, where the Gemfile asks for a Ruby: `ruby 3.3.6p108`,
  // without the patchlevel from Bundler 4, and the engine where not Ruby,
  // `ruby 3.1.4p0 (jruby 9.4.5.0)`.
  rubyVersion: string | undefined
  // BUNDLED WITH: the version of Bundler that wrote it, which Bundler 2.3
  // and later switch to. Bundler writes it always, but leaves a lockfile
  // without it, or without RUBY VERSION, so where nothing else changes.
  bundledWith: string | undefined
}

export interface BundlerSpec {
  name: string
  version: string
  // `ruby` for a gem of no platform, which may build an extension where
  // it is installed.
  platform: string
  // An index into `sources`.
  source: number
  // Its runtime dependencies by name, each a name of `gems`, or `bundler`:
  // their requirements, as a BundlerDependency's.
  dependencies: Record<string, string[]>
  // `sha256=` and the hex sha256 of its .gem, from CHECKSUMS; undefined
  // without, and for a git or a path source's gem.
  checksum: string | undefined
}

// `requirements` are `op version`, `~> 1.4`, all of which a version meets,
// in the order Bundler writes them; none for any version.
export interface BundlerDependency {
  requirements: string[]
  // `!`: the Gemfile names its source, a git or a path one, or a `source`
  // block's, which its gems are then from. Without it, they are from
  // Bundler's default source: the Gemfile's own GEM one, or, in Bundler 2,
  // the directory of a lone `path`.
  pinned: boolean
}

// `glob`, of a git or a path source, is what Bundler finds the gemspecs
// by, where not its default, `{,*,*/*}.gemspec`.
export type BundlerSource =
  // A server of the gem API, by its URL, a directory of gems, by a
  // `file:///` one, or an S3 bucket of them, by an `s3://` one, with a `/`
  // at the end; undefined for the source of a Gemfile that names none, and
  // so has no gems.
  | { type: 'gem', remote: string | undefined }
  // A repository by URL, or by path, as the Gemfile has it; `revision` the
  // commit it resolved to, and each of `ref`, `branch` and `tag` what was
  // asked for, as written.
  | {
    type: 'git'
    remote: string
    revision: string
    ref: string | undefined
    branch: string | undefined
    tag: string | undefined
    submodules: boolean
    glob: string | undefined
  }
  // A directory, from the lockfile's, `/` between segments.
  | { type: 'path', path: string, glob: string | undefined }
