// A name is asserted to be a gem name as RubyGems takes one: letters,
// digits, `.`, `-` and `_`, a letter among them, none of the three others
// first, and told apart by case, as rubygems.org tells `Rack` from `rack`.
// A version is asserted to be Gem::Version's as Gemfile.lock writes it,
// digits first and no `-`; a platform to be `ruby`, for a gem of no
// platform, or one as RubyGems writes it, which RubyGems 3 and 4 both read
// back as written, `x86_64-linux` or `arm64-darwin`, say; and a checksum a
// sha256 in lowercase hex, alone or after `sha256=`, as Gemfile.lock's
// CHECKSUMS has it, so @preventive/lockfile's BundlerSpec passes its name,
// version, platform and checksum as they are. All of it before any request
// or cache path. The cache is setCacheDir's (npm.js).

export { HttpError } from './npm.js'

// Reads the compact index, Bundler's, for that version and platform and
// throws unless its sha256 is the one given, as for a checksum read off
// Gemfile.lock. The index is read on every call; nothing is cached.
export function verifyChecksum(name: string, version: string, platform: string, checksum: string): Promise<void>

// A published version's .gem, whole, in memory: of `platform`, the file
// RubyGems names `<name>-<version>.gem` for `ruby`, and
// `<name>-<version>-<platform>.gem` for any other. `checksum` is its
// sha256; without one, the compact index, index.rubygems.org/info/<name>,
// is read for it on every call, cached gem or not, and an index with a
// line that is not a version's, with none or two for that version and
// platform, or with a checksum there not one sha256 in lowercase hex,
// throws. Either way the bytes are checked against it, whether they were
// downloaded from rubygems.org/gems/ (before they are cached), where a
// redirect is not followed, or read from a cache. A yanked version's file
// is gone from rubygems.org, and its line from the index, but a copy kept
// still matches: the version is never pushed again.
//
// RubyGems' own caches are read first, and never written: the file in the
// cache/ of each absolute directory of GEM_PATH and of GEM_HOME, and of each
// Gem.user_dir, `<engine>/<ruby version>` under ~/.gem, and under
// $XDG_DATA_HOME/gem, else ~/.local/share/gem, which RubyGems takes where
// there is no ~/.gem. Gem.default_dir is under the prefix Ruby was built
// with, so is read only as GEM_PATH or GEM_HOME names it. A file there that
// does not match is passed over. One in setCacheDir's cache that does not
// match throws.
export function getGem(name: string, version: string, platform: string, checksum?: string): Promise<Uint8Array>
