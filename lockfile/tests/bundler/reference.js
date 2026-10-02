// RubyGems and Bundler as the reference, all in one Ruby process: how
// Gem::Version orders two versions, whether Gem::Requirement takes one,
// what Gem::Platform writes a platform back as, and what Bundler's own
// LockfileParser reads a lockfile to. RUBY names the interpreter, ruby by
// default, and RUBYOPT may name another RubyGems; undefined comes back
// where it, or Bundler 2.5 or later, which reads CHECKSUMS, is missing.
// Bundler is the newest the interpreter has.
import { spawnSync } from 'node:child_process'

const SCRIPT = String.raw`
require "json"
require "tmpdir"
require "bundler"

# Bundler reads a path source from the Gemfile's directory, which is to be
# somewhere, if not anything.
ENV["BUNDLE_GEMFILE"] = File.join(Dir.mktmpdir, "Gemfile")

def checksums(store, spec)
  line = store.to_lock(spec)
  line == spec.lock_name ? nil : line.delete_prefix("#{spec.lock_name} ")
end

def source(source)
  case source
  when Bundler::Source::Git then { "type" => "git", "remote" => source.uri, "options" => source.options.slice("revision", "ref", "branch", "tag", "submodules", "glob") }
  when Bundler::Source::Path then { "type" => "path", "path" => source.options["path"], "glob" => source.options["glob"] }
  when Bundler::Source::Rubygems then { "type" => "gem", "remotes" => source.remotes.map(&:to_s) }
  else { "type" => source.class.name }
  end
end

def lockfile(text)
  parser = Bundler::LockfileParser.new(text)
  sources = parser.sources
  {
    "sources" => sources.map {|s| source(s) },
    "specs" => parser.specs.map do |spec|
      {
        "key" => spec.full_name, "name" => spec.name, "version" => spec.version.to_s, "platform" => spec.platform.to_s,
        "source" => sources.index(spec.source),
        "dependencies" => spec.dependencies.map {|dep| [dep.name, dep.requirement.as_list] },
        "checksum" => checksums(spec.source.checksum_store, spec),
      }
    end,
    "dependencies" => parser.dependencies.values.map {|dep| [dep.name, dep.requirement.as_list, dep.source && sources.index(dep.source)] },
    "platforms" => parser.platforms.map(&:to_s),
    "checksums" => parser.checksums ? true : false,
    # Bundler's own checksum, which Bundler 2 skips.
    "metadata" => parser.respond_to?(:metadata_source) ? parser.metadata_source.checksum_store.instance_variable_get(:@store).transform_values {|by| by.values.map(&:to_lock) } : nil,
    "ruby" => parser.ruby_version,
    "bundler" => parser.bundler_version&.to_s,
  }
end

KINDS = {
  "compare" => ->(pair) { Gem::Version.new(pair[0]) <=> Gem::Version.new(pair[1]) },
  "correct" => ->(text) { Gem::Version.correct?(text) },
  "satisfies" => ->(pair) { Gem::Requirement.new(pair[0]).satisfied_by?(Gem::Version.new(pair[1])) },
  "platform" => ->(text) { Gem::Platform.new(text).to_s },
  "lockfile" => method(:lockfile),
  "versions" => ->(_) { [Gem::VERSION, Bundler::VERSION] },
}

results = JSON.parse($stdin.read).map do |kind, input|
  { "value" => KINDS.fetch(kind).call(input) }
rescue StandardError, ScriptError => e
  { "error" => e.class.name }
end
$stdout.write(JSON.generate(results))
`

// Each case is [kind, input]; each result { value } or { error }.
export function ruby(cases) {
  const run = spawnSync(process.env.RUBY ?? 'ruby', ['-e', SCRIPT], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.error !== undefined || run.status !== 0) return undefined
  return JSON.parse(run.stdout)
}

// [RubyGems, Bundler], or undefined.
export const versions = () => ruby([['versions', null]])?.[0]?.value

export function hasBundler() {
  const [major, minor] = versions()?.[1].split('.').map(Number) ?? [0, 0]
  return major > 2 || (major === 2 && minor >= 5)
}
