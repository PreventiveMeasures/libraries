// Records what Bundler writes for the projects below into
// tests/bundler/fixtures/. Needs ruby and gem, which install each Bundler
// at its version into a directory of its own, git, and network access to
// rubygems.org, gem.coop and github.com:
//
//     node lockfile/scripts/record-bundler.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what the tools say as they run.
//
// project: a gem of its own, by `gemspec`, with a runtime and a development
// dependency, that asks for every kind of source Bundler locks: gems from
// rubygems.org, one with a gem for each platform, one of three
// requirements, and one for JRuby alone, which is locked for no platform
// here; a gem from a source of its own, gem.coop; a directory with a glob;
// a git repository by tag, one of two gems by a full commit and a glob, and
// one by branch with its submodules. Locked for x86_64-linux, arm64-darwin
// and ruby, with the Ruby that runs. Bundler 2.6 and 2.7 write CHECKSUMS
// where asked, 4.0 for a new lockfile, with its own gem's; 2.5 and older
// write none.
//
// path: a directory alone, and no source: an empty GEM, of no remote.
//
// upgrade: the project locked by Bundler 2.7 and again by 4.0, which
// keeps the Ruby 2.7 locked, patchlevel and all, and adds no CHECKSUMS.
//
// What each resolves to is rubygems.org's and GitHub's on the day it is
// recorded, but for the versions the Gemfile pins.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('../tests/bundler/fixtures/', import.meta.url))

// Ruby's own gems, which Bundler needs some of.
const DEFAULT_GEMS = execFileSync('ruby', ['-e', 'print Gem.default_dir'], { encoding: 'utf8' })

// Each run installs into a directory of its own, and reads no config but its own.
function run(command, args, cwd, home) {
  const env = { ...process.env, GEM_HOME: home, GEM_PATH: `${home}:${DEFAULT_GEMS}`, BUNDLE_USER_HOME: join(home, '.bundle'), BUNDLE_APP_CONFIG: join(cwd, '.bundle') }
  execFileSync(command, args, { cwd, env, stdio: ['ignore', process.env.VERBOSE ? 'inherit' : 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] })
}

function bundle(version, args, dir, home) {
  run('gem', ['install', 'bundler', '--version', version, '--install-dir', home, '--no-document'], dir, home)
  run(join(home, 'bin', 'bundle'), [`_${version}_`, ...args], dir, home)
}

const SINATRA = '7b50a1bbb5324838908dfaa00ec53ad322673a29'

const gemspec = (name, lines) => `Gem::Specification.new do |s|
  s.name = "${name}"
  s.version = "0.1.0"
  s.summary = "${name}"
  s.authors = ["fixture"]
  s.files = ["lib/${name}.rb"]
${lines.map((line) => `  ${line}\n`).join('')}end
`

// A gem of its own, with a module, in `dir`.
function local(dir, name, lines = []) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', `${name}.rb`), '')
  writeFileSync(join(dir, `${name}.gemspec`), gemspec(name, lines))
}

const GEMFILE = `source "https://rubygems.org"

gemspec

ruby RUBY_VERSION

gem "rake", "~> 13.0"
gem "nokogiri", "1.16.7"
gem "rack", ">= 2.2", "!= 3.0.0", "< 4"
gem "tzinfo-data", platforms: [:jruby]
gem "localgem", path: "vendor/localgem", glob: "*.gemspec"
gem "rack-test", git: "https://github.com/rack/rack-test.git", tag: "v2.1.0"
gem "sinatra", git: "https://github.com/sinatra/sinatra.git", ref: "${SINATRA}", glob: "{,*/}*.gemspec"
gem "tsort", git: "https://github.com/ruby/tsort.git", branch: "master", submodules: true

source "https://gem.coop" do
  gem "rainbow", "3.1.1"
end
`

function project(dir) {
  local(dir, 'myapp', ['s.add_dependency "racc", "~> 1.4"', 's.add_development_dependency "minitest", "~> 5.0"'])
  local(join(dir, 'vendor', 'localgem'), 'localgem', ['s.add_dependency "rack", ">= 2.2"'])
  writeFileSync(join(dir, 'Gemfile'), GEMFILE)
}

const PLATFORMS = ['--add-platform', 'x86_64-linux', 'arm64-darwin', 'ruby']

const keep = (dir, name) => {
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(join(FIXTURES, `${name}.lock`), readFileSync(join(dir, 'Gemfile.lock'), 'utf8'))
}

const lock = (version, checksums) => (dir, home) => {
  project(dir)
  bundle(version, ['lock', ...PLATFORMS, ...(checksums ? ['--add-checksums'] : [])], dir, home)
  keep(dir, `bundler-${version}`)
}

const RUNS = {
  'bundler-2.2.34': lock('2.2.34', false),
  'bundler-2.4.22': lock('2.4.22', false),
  'bundler-2.5.23': lock('2.5.23', false),
  'bundler-2.6.9': lock('2.6.9', true),
  'bundler-2.7.2': lock('2.7.2', true),
  'bundler-4.0.22': lock('4.0.22', false),
  'bundler-4.0.22-path': (dir, home) => {
    local(join(dir, 'plain'), 'plain')
    writeFileSync(join(dir, 'Gemfile'), 'gem "plain", path: "plain"\n')
    bundle('4.0.22', ['lock'], dir, home)
    keep(dir, 'bundler-4.0.22-path')
  },
  'bundler-4.0.22-upgrade': (dir, home) => {
    project(dir)
    bundle('2.7.2', ['lock', ...PLATFORMS], dir, home)
    bundle('4.0.22', ['lock'], dir, home)
    keep(dir, 'bundler-4.0.22-upgrade')
  },
}

const only = process.argv.slice(2)
for (const name of only) if (!(name in RUNS)) throw new Error(`no run ${name}`)

for (const [name, record] of Object.entries(RUNS)) {
  if (only.length > 0 && !only.includes(name)) continue
  const dir = mkdtempSync(join(tmpdir(), `record-bundler-${name}-`))
  const home = mkdtempSync(join(tmpdir(), `record-bundler-${name}-gems-`))
  try {
    record(dir, home)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}
