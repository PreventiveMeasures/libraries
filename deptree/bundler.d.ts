import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/bundler.js'

// Where @preventive/upstream caches what it fetches, .gem files among
// them. Each .gem is fetched through it, and that is the one place
// anything here touches a filesystem. Before the network, it takes one from
// RubyGems' own caches -- the cache/ of each directory of GEM_PATH and
// GEM_HOME, and of each Gem.user_dir -- where one there has the lockfile's
// checksum, or rubygems.org's where the lockfile has none, and writes none
// of it; then from its own cache, where one is set, which is where it
// writes each .gem it fetches: setCacheDir() sets the default one, and
// setCacheDir(false) unsets it. Unset, which it is until set, it writes
// nothing. The project is read only through the view given as `project`,
// and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine Bundler would install on, CRuby's: `bundler` the version
// that installs, exact, 2.5.12 to 2.7.x or 4.0.x, which take a lockfile's
// gems alike where nothing has them resolve anew, where those before
// 2.5.12 install no gem that is a default gem of the Ruby, which the
// lockfile does not tell; `rubygems` the RubyGems it runs on, exact, 3.5.15
// to 4.0.x, as Gem::VERSION gives it, which unpack a .gem alike but for
// what is refused below, where those before 3.5.8 keep the modes a umask
// drops; `ruby` RUBY_VERSION, 3.0.0 to 4.0.x, whose ruby_version, X.Y.0 as
// CRuby is built by default, the install path is scoped by; `platform`
// Gem::Platform.local as RubyGems writes it -- `x86_64-linux`,
// `aarch64-linux-musl`, `arm64-darwin-23` -- one every release of RubyGems
// here reads alike; `os` as Node names it -- `linux` or `darwin`, the
// platform's own. Windows is refused: RubyGems names and links files
// otherwise there.
export interface BundlerHost {
  bundler: string
  rubygems: string
  ruby: string
  platform: string
  os: string
}

// A view of the project's root, by paths from `/`: a Vfs, or anything with
// its readdir, lstat, stat and readFile, such as one of a directory on
// disk, of which only this is read: whether gems.rb or else Gemfile is a
// file, as Bundler finds a Gemfile; its lockfile, gems.locked or
// Gemfile.lock; and .bundle/config, where there is one. Each is read as
// UTF-8, and refused where it is not; the Gemfile is not read. A link at or
// on the way to either file read is refused, so that nothing is read from
// outside the view. Each throws an error whose `code` is ENOENT, ENOTDIR or
// ELOOP for a path that leads nowhere. Nothing is written to it.
export interface BundlerProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The lockfile `bundle install` reads, run at the project's root: given as
// text, with `lockfile`, or read, with `project`.
//
// `path` is BUNDLE_PATH, the directory Bundler installs under, from the
// project's root, by segments with no `.`, `..` or empty one, and no `~`
// first, which Bundler expands as a home directory; by default, what
// .bundle/config sets it to, as `bundle config set --local path` writes
// it, where `project` is given and it has it, and else vendor/bundle. A
// `path` other than the one .bundle/config sets is refused. Of the
// settings in .bundle/config, BUNDLE_PATH is read; BUNDLE_FROZEN,
// BUNDLE_DEPLOYMENT, BUNDLE_JOBS and BUNDLE_RETRY are passed over, as they
// bear on no file installed where nothing is resolved anew; any other is
// refused, as it may. Settings from anywhere else -- the user's
// ~/.bundle/config, the environment, the command line -- are not read, and
// are taken to be at their defaults, but for BUNDLE_PATH, which is `path`.
//
// `partial` skips each gem refused for being one deptree does not build --
// one from git, and one with extensions -- rather than refusing the call.
// Nothing is written for it, and it is listed in `skipped`, for Bundler to
// install. A .gem is held to its checksum all the same. Every other
// refusal stands.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to be
// the project's -- it may be `project` too; without one, a new Vfs holds
// the tree alone. A Vfs that holds `path` already, or on macOS a name that
// is one with it there, is refused before anything is fetched, as Bundler
// takes what is in it as installed. Nothing there is written over: each
// directory the tree has is one there or is made, and every file is
// written where nothing is. The tree is built, and held to every check
// below, before any of it is written, so a refusal leaves the Vfs as it
// was.
export type BundlerTreeOptions = BundlerTreeGiven | BundlerTreeRead

export interface BundlerTreeGiven {
  lockfile: string
  project?: undefined
  path?: string
  host: BundlerHost
  partial?: boolean
  vfs?: Vfs
}

export interface BundlerTreeRead {
  lockfile?: undefined
  project: BundlerProject
  path?: string
  host: BundlerHost
  partial?: boolean
  vfs?: Vfs
}

// What buildBundlerTree counts, all of it plain numbers: `specs` the
// lockfile's; `installed` the gems written, each a .gem fetched; `files`
// and `bytes` what is written, each .gem among it, and `links` the
// symlinks.
export interface BundlerTreeStats {
  specs: number
  installed: number
  files: number
  bytes: number
  links: number
}

// A gem in the tree, as an SBOM would list it: `path` is its directory,
// from the project's root, which is `/` of the Vfs --
// <path>/ruby/<X.Y.0>/gems/<full name>; `name`, `version` and `platform`
// the lockfile's, `ruby` for a gem of no platform; `source` its GEM
// remote, https://rubygems.org/; `checksum` the hex sha256 of its .gem,
// held to the lockfile's or else to rubygems.org's; `homepage` and
// `sourceCodeUri` what its spec gives as homepage and as
// metadata["source_code_uri"], each undefined where it gives no string.
// All of it is the publisher's word, held to no repository.
export interface BundlerInstalled {
  path: string
  name: string
  version: string
  platform: string
  source: string
  checksum: string
  homepage: string | undefined
  sourceCodeUri: string | undefined
}

// A gem `partial` skips: `name`, `version` and `platform` the lockfile's;
// `reason` the refusal's message, as the call throws it without `partial`,
// leading with `specs["<full name>"]`; `paths` where Bundler installs
// what is not built for it, from the project's root: of a gem with
// extensions, its directory and its .gem; of one from git, the
// bundler/gems and cache/bundler/git under the scope, which every git
// gem's checkout and clone are in.
export interface BundlerSkipped {
  name: string
  version: string
  platform: string
  reason: string
  paths: string[]
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each gem written, in the lockfile's order; `skipped` each
// gem `partial` skips, in the lockfile's order, and none without it.
export interface BundlerTree {
  vfs: Vfs
  stats: BundlerTreeStats
  installed: BundlerInstalled[]
  skipped: BundlerSkipped[]
}

// What `bundle install` writes under BUNDLE_PATH, with host.bundler,
// host.rubygems and none of their options, a umask of 0o022, in a project
// with nothing at `path` yet: rooted at the project's root, it holds
// <path>/ruby/<X.Y.0>/cache/<full name>.gem and
// <path>/ruby/<X.Y.0>/gems/<full name> for each gem installed from
// rubygems.org, and nothing else of the project; none at all where no
// gem is. The full name is the lockfile's key: `name-version`, or
// `name-version-platform` for a platform's gem. What Bundler and RubyGems
// write beside them is not built: specifications/, the stubs in bin/,
// extensions/, build_info/, plugins/ and doc/ under the scope, nor
// .bundle/config or the lockfile again. A gem from a path source is
// installed nowhere, as Bundler reads it where it is.
//
// The gems are those Bundler materializes on the machine, as 2.5 to 4.0
// do where nothing has them resolve anew: from DEPENDENCIES, through the
// lockfile's dependencies of each gem, the one of each name whose platform
// is most specific to host.platform of those installable there, as
// Gem::Platform#=== has it, `ruby` the least. A Gemfile is taken to ask
// for what the lockfile has and to limit none of it to platforms: a
// dependency with no gem locked is taken to be for a platform the
// lockfile locks none of, as one by `platforms:` is, and none of the gems
// Bundler leaves out for a `platforms:` of a platform it does lock is left
// out here, as the lockfile does not say which they are; nor is any gem of
// a group BUNDLE_WITHOUT would leave out. `force_ruby_platform` is at its
// default, off.
//
// What has Bundler resolve anew, which it does rather than install the
// lockfile as it is, is refused: a lockfile none of whose PLATFORMS is the
// machine's -- `ruby`, host.platform itself, or one each takes the other
// for, as 2.5 matches them one way and 2.6 and later the other; a
// gem of no platform installable there, or of two as specific; a .gem
// whose runtime dependencies are not the lockfile's, or that requires a
// Ruby or a RubyGems that host.ruby or host.rubygems does not meet. So is
// a lockfile BUNDLED WITH another Bundler than host.bundler, which Bundler
// installs into the path and switches to; and one whose PLATFORMS is
// `ruby` alone, for which Bundler takes each gem of whatever platform
// rubygems.org has for the machine, as it did before 2.2.
//
// Each .gem is fetched from rubygems.org with
// @preventive/upstream/rubygems.js's getGem, held to the lockfile's
// checksum, its sha256, or where the lockfile has none, to rubygems.org's
// compact index's, as Bundler holds it. It is read as Gem::Package#verify
// reads it with no security policy: a tar of metadata.gz, data.tar.gz and
// checksums.yaml.gz, the last optional, and a .sig of any, each once; each
// checksum checksums.yaml.gz has, SHA1, SHA256, SHA384 or SHA512, held to
// its file, as one of another file, or of a .sig, which RubyGems digests
// none of, is refused; each gzipped member read as Zlib reads it, within 10
// MiB for metadata.gz and checksums.yaml.gz as RubyGems bounds them. Its
// spec, the YAML metadata.gz holds, is read as Gem::Specification
// .from_yaml reads it, by Psych with the classes RubyGems permits, and held
// to the lockfile: its name, version and platform, as written, and its
// runtime dependencies, by Gem::Requirement#==; and to what
// Gem::Installer#verify_spec checks.
//
// data.tar.gz is unpacked as Gem::Package#extract_tar_gz unpacks it for
// Bundler, with no dir_mode, prog_mode or data_mode: each entry where
// File.expand_path puts it under the gem's directory, each directory on
// the way 0o755 but those its own entry makes, of that entry's mode as
// chmod sets it, past the umask, those on the way to it too; each file its
// mode within 0o777 as the umask leaves it; each symlink once every entry
// is, and where what it leads to is not there, which RubyGems passes over
// with a warning, left out, a link it leads through followed as the
// machine follows one, up to 40 on Linux and 32 on macOS. Then each
// executable the spec names, in its bindir, is made executable by all, as
// Gem::Installer#generate_bin makes it, through a link. Every entry is
// read as RubyGems' TarReader reads it and as @preventive/archive/tar.js
// does, the two held to read it alike: what the archive reader refuses is
// refused -- a name with a backslash, a control or formatting character,
// an empty or `..` segment or one longer than 255 bytes, which no
// filesystem holds, two entries of one name that differ, an entry
// inside one that is not a directory, a symlink that leads out of the
// archive or through anything but a directory -- and so is what RubyGems
// reads otherwise: an extended header, pax or GNU's, which RubyGems reads
// as an entry of its own; a name, a prefix or a link target ending in a
// space, or with a NUL in it; a field not octal as TarHeader reads it.
//
// What RubyGems refuses or fails on is refused: an entry or a link that
// leads out of the gem's directory, or to the directory itself, or that
// starts with `~`, which File.expand_path reads as a home directory; an
// entry other than a file, a directory or a symlink, of which RubyGems
// makes nothing but its directory; an entry where one is already, which it
// removes first, but for the same file again; a link twice, or where
// anything else is made, which it fails to make; an executable that leads
// out of the gem's directory. So is what
// one release reads otherwise than another: a setuid, setgid or sticky
// bit, which RubyGems 4.0.24 drops and those before keep. And what it
// fails on as any user but root: anything made in a directory whose mode
// lacks its owner's write or search. On macOS, two names in one directory
// that differ only in case or normalization are refused, as they would be
// one name there.
//
// Gems come from rubygems.org, from a path, or with `partial` from git: one
// from another GEM remote is refused, and one from git, which Bundler
// checks out with git, or one whose spec has extensions, whose directory
// would hold what building them makes, is refused or with `partial`
// skipped. A .gem that unpacks to more than 512 MiB, or twenty times its
// size where that is more, is refused, a bound of ours.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a gem
// from anywhere but rubygems.org, a check above that fails -- each is
// refused with a DeptreeError or a LockfileError that says where. A
// TypeError is thrown for options of the wrong type.
export function buildBundlerTree(options: BundlerTreeOptions): Promise<BundlerTree>

// `where` is what a refusal is about -- `specs["rack-3.1.8"]`, an entry of
// a .gem, `host.platform` -- or undefined for the call as a whole; the
// message leads with it. `cause` is what a package beneath refused with,
// where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
