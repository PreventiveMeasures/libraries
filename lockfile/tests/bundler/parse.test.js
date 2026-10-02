import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseGemfileLock } from '../../bundler.js'

const H = 'a'.repeat(64)
const C = 'c'.repeat(40)

// As Bundler 4 writes it: a git and a path source, a gem of a platform of
// its own beside the one of none, a dependency for a platform not locked,
// and every gem's checksum, Bundler's own among them.
const BASE = `GIT
  remote: https://github.com/o/g.git
  revision: ${C}
  branch: main
  specs:
    g (1.0.0)
      a (~> 1.0)

PATH
  remote: .
  specs:
    app (0.1.0)
      a (>= 1.0, < 2)

GEM
  remote: https://rubygems.org/
  specs:
    a (1.2.0)
    n (1.0.0)
      a (~> 1.2)
    n (1.0.0-x86_64-linux)
      a (~> 1.2)

PLATFORMS
  ruby
  x86_64-linux

DEPENDENCIES
  app!
  g!
  n (= 1.0.0)
  t

CHECKSUMS
  a (1.2.0) sha256=${H}
  app (0.1.0)
  bundler (4.0.22) sha256=${H}
  g (1.0.0)
  n (1.0.0) sha256=${H}
  n (1.0.0-x86_64-linux) sha256=${H}

RUBY VERSION
  ruby 3.3.6

BUNDLED WITH
  4.0.22
`

function edit(...edits) {
  let text = BASE
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where) => assert.throws(() => parseGemfileLock(text), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const plain = (value) => JSON.parse(JSON.stringify(value))

describe('a lockfile of Bundler 4', () => {
  const lock = parseGemfileLock(BASE)

  it('each source, in order', () => {
    assert.deepEqual(plain(lock.sources), [
      { type: 'git', remote: 'https://github.com/o/g.git', revision: C, branch: 'main', submodules: false },
      { type: 'path', path: '.' },
      { type: 'gem', remote: 'https://rubygems.org/' },
    ])
  })

  it('each gem by full name, and the gems of each name', () => {
    assert.deepEqual(Object.keys(lock.specs), ['g-1.0.0', 'app-0.1.0', 'a-1.2.0', 'n-1.0.0', 'n-1.0.0-x86_64-linux'])
    assert.deepEqual(plain(lock.specs['n-1.0.0-x86_64-linux']), { name: 'n', version: '1.0.0', platform: 'x86_64-linux', source: 2, dependencies: { a: ['~> 1.2'] }, checksum: `sha256=${H}` })
    assert.deepEqual(plain(lock.specs['app-0.1.0']), { name: 'app', version: '0.1.0', platform: 'ruby', source: 1, dependencies: { a: ['>= 1.0', '< 2'] } })
    assert.deepEqual(plain(lock.gems), { g: ['g-1.0.0'], app: ['app-0.1.0'], a: ['a-1.2.0'], n: ['n-1.0.0', 'n-1.0.0-x86_64-linux'] })
  })

  it('the platforms, what the Gemfile asks for, and the versions', () => {
    assert.deepEqual(lock.platforms, ['ruby', 'x86_64-linux'])
    assert.deepEqual(plain(lock.dependencies), {
      app: { requirements: [], pinned: true },
      g: { requirements: [], pinned: true },
      n: { requirements: ['= 1.0.0'], pinned: false },
      t: { requirements: [], pinned: false },
    })
    assert.deepEqual([lock.checksums, plain(lock.bundlerChecksum), lock.rubyVersion, lock.bundledWith], [true, { version: '4.0.22', checksum: `sha256=${H}` }, 'ruby 3.3.6', '4.0.22'])
  })

  it('refuses anything but a string with a TypeError', () => {
    assert.throws(() => parseGemfileLock(Buffer.from(BASE)), TypeError)
  })
})

describe('the layout', () => {
  it('as Bundler 2 writes it: three spaces in, and no CHECKSUMS', () => {
    const text = edit(['\n  ruby 3.3.6\n', '\n   ruby 3.3.6p108\n'], ['\n  4.0.22\n', '\n   2.7.2\n']).replace(/CHECKSUMS\n(?: {2}.*\n)+\n/u, '')
    const lock = parseGemfileLock(text)
    assert.deepEqual([lock.checksums, lock.bundlerChecksum, lock.rubyVersion, lock.bundledWith], [false, undefined, 'ruby 3.3.6p108', '2.7.2'])
    assert.equal(lock.specs['a-1.2.0'].checksum, undefined)
    refuses(edit(['\n  ruby 3.3.6\n', '\n   ruby 3.3.6\n']), '3 spaces of indentation, and 2 under BUNDLED WITH at line 43')
    refuses(edit(['\n  4.0.22\n', '\n    4.0.22\n']), 'expected 2 or 3 spaces of indentation, found 4 at line 46')
  })

  it('each line ended alike, LF or CRLF, the last one too, and no blank line but between sections', () => {
    assert.deepEqual(parseGemfileLock(BASE.replaceAll('\n', '\r\n')).platforms, ['ruby', 'x86_64-linux'])
    refuses(BASE.replace('\n', '\r\n'), 'a LF line end, after CRLF ones at line 2')
    refuses(BASE.slice(0, -1), 'no line end after the last line, where Bundler ends every line')
    refuses(`${BASE}\n`, 'a blank line at the end, where Bundler writes none at line 47')
    refuses(`\n${BASE}`, 'a blank line, where Bundler writes one between sections alone at line 1')
    refuses(edit(['\n\nPATH', '\n\n\nPATH']), 'a blank line, where Bundler writes one between sections alone at line 9')
    refuses(edit(['\n\nPATH', '\nPATH']), 'expected a blank line before "PATH" at line 8')
    refuses(edit(['  ruby\n', '  ruby\n\n']), 'expected a section, at column 0 at line 27')
    refuses('', 'an empty lockfile, which Bundler reads as none')
  })

  it('refuses a character Bundler does not write, and a merge conflict', () => {
    refuses(edit(['    a (1.2.0)', '\ta (1.2.0)']), 'U+0009 is not allowed at line 18')
    refuses(edit(['  t\n', '<<<<<<< HEAD\n  t\n']), '"<<<<<<<", which Bundler reads as a merge conflict')
    refuses(edit(['branch: main', 'branch: ma=======in']), '"=======", which Bundler reads as a merge conflict')
  })

  it('the sources first, GEM last, then each section once, in order', () => {
    refuses(edit(['\nGEM\n', '\nGEMS\n']), '"GEMS" is not a section Bundler writes at line 15')
    refuses(edit(['\nGEM\n', '\nPLUGIN SOURCE\n']), 'a plugin source, which only its plugin can read, and which is not read here at line 15')
    refuses(BASE.replace(/PATH\n(?: {2}.*\n)+\n/u, '').replace('PLATFORMS\n', 'PATH\n  remote: .\n  specs:\n    app (0.1.0)\n      a (>= 1.0, < 2)\n\nPLATFORMS\n'), 'a PATH source after a GEM one, where Bundler writes the GEM sources last at line 18')
    refuses(edit(['\nPLATFORMS\n  ruby\n  x86_64-linux\n', '\nPLATFORMS\n  ruby\n  x86_64-linux\n\nGEM\n  specs:\n']), 'a GEM source after PLATFORMS, where Bundler writes the sources first at line 28')
    refuses(edit(['\nDEPENDENCIES\n', '\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n']), 'a second PLATFORMS at line 28')
    refuses(edit(['\nRUBY VERSION\n  ruby 3.3.6\n', ''], ['\nBUNDLED WITH\n  4.0.22\n', '\nBUNDLED WITH\n  4.0.22\n\nRUBY VERSION\n  ruby 3.3.6\n']), 'RUBY VERSION after BUNDLED WITH, where Bundler writes it before at line 45')
    refuses(edit(['PLATFORMS\n  ruby\n  x86_64-linux\n\n', '']), 'no PLATFORMS, which Bundler always writes')
    refuses(edit(['PLATFORMS\n  ruby\n  x86_64-linux\n', 'PLATFORMS\n']), 'no platform under PLATFORMS at line 24')
    refuses(edit(['\n  ruby 3.3.6\n', '\n  ruby 3.3.6\n  ruby 3.3.6\n']), 'expected one line under RUBY VERSION, found 2 at line 42')
  })

  it('a source\'s options, in order, then its specs, four spaces in, and their dependencies, six', () => {
    refuses(edit(['  branch: main\n', '  branch: main\n  depth: 1\n']), '"depth" is not an option Bundler writes for a GIT source at line 5')
    refuses(edit(['  revision: c', '  revisions: c']), '"revisions" is not an option Bundler writes for a GIT source at line 3')
    refuses(edit([`  revision: ${C}\n  branch: main\n`, `  branch: main\n  revision: ${C}\n`]), 'revision after branch, where Bundler writes it before at line 4')
    refuses(edit([`  revision: ${C}\n`, '']), 'a GIT source without its revision at line 1')
    refuses(edit(['  branch: main\n  specs:\n', '  branch: main\n']), 'expected an option, "key: value", or "specs:", two spaces in, found "    g (1.0.0)" at line 5')
    refuses(edit(['  branch: main', '  branch:main']), 'expected an option, "key: value", or "specs:", two spaces in, found "  branch:main" at line 4')
    refuses(edit(['  branch: main', '  branch: main ']), '"main " has a space at an end, which no branch Bundler writes has at line 4')
    refuses(edit(['    a (1.2.0)', '     a (1.2.0)']), 'expected 4 or 6 spaces of indentation, found 5 at line 18')
    refuses(edit(['    a (1.2.0)', '  a (1.2.0)']), 'expected 4 or 6 spaces of indentation, found 2 at line 18')
    refuses(edit(['  specs:\n    a (1.2.0)\n', '  specs:\n      b\n    a (1.2.0)\n']), 'a dependency before any spec at line 18')
    refuses(edit(['    a (1.2.0)', '    a (1.2.0) ']), 'expected a gem as "name (version)", found "a (1.2.0) " at line 18')
    refuses(edit(['    a (1.2.0)', '    a (1.2.0) sha256=x']), 'expected a gem as "name (version)", found "a (1.2.0) sha256=x" at line 18')
    refuses(edit(['    a (1.2.0)', '    a']), 'expected a gem as "name (version)", found "a" at line 18')
    refuses(edit(['      a (~> 1.0)', '      a (~> 1.0)!']), 'expected a dependency as "name" or "name (requirement)", found "a (~> 1.0)!" at line 7')
    refuses(edit(['  ruby\n', '   ruby\n']), 'expected 2 spaces of indentation, found 3 at line 25')
  })
})

describe('sources', () => {
  it('a git repository at a full commit, as asked for', () => {
    const lock = parseGemfileLock(edit(['  branch: main\n', `  ref: ${C}\n  tag: v1.0\n  submodules: true\n  glob: */*.gemspec\n`]))
    assert.deepEqual(plain(lock.sources[0]), { type: 'git', remote: 'https://github.com/o/g.git', revision: C, ref: C, tag: 'v1.0', submodules: true, glob: '*/*.gemspec' })
    assert.equal(parseGemfileLock(edit(['remote: https://github.com/o/g.git', 'remote: git@github.com:o/g.git'])).sources[0].remote, 'git@github.com:o/g.git')
    refuses(edit([`revision: ${C}`, 'revision: cccccc']), '"cccccc" is not a full commit hash', 'sources[0].revision')
    refuses(edit([`revision: ${C}`, `revision: ${C.toUpperCase()}`]), `"${C.toUpperCase()}" is not a full commit hash`, 'sources[0].revision')
    refuses(edit(['  branch: main', `  ref: ${'d'.repeat(40)}`]), `the commit ${'d'.repeat(40)}, and the revision another`, 'sources[0].ref')
    refuses(edit(['  branch: main', '  ref: a b']), '"a b" is not a reference git reads', 'sources[0].ref')
    refuses(edit(['  branch: main', '  branch: a..b']), '"a..b" is not a branch or tag name git takes', 'sources[0].branch')
    assert.equal(parseGemfileLock(edit(['remote: https://github.com/o/g.git', 'remote: ../my repo'])).sources[0].remote, '../my repo')
    refuses(edit(['g.git\n', 'g.git/\n']), '"https://github.com/o/g.git/" ends in "/", which Bundler 2.4 and later drop as they read it, and 2.2 and 2.3 keep', 'sources[0].remote')
    refuses(edit(['  branch: main', '  submodules: false']), 'expected "true", found "false"', 'sources[0].submodules')
    refuses(edit(['  branch: main', '  glob: {,*,*/*}.gemspec']), '"{,*,*/*}.gemspec", which Bundler reads by where none is written, and does not write', 'sources[0].glob')
  })

  it('a git repository git reads as one alone, as Bundler before 2.2.33 clones it with no "--" before it', () => {
    const remote = (value) => edit(['remote: https://github.com/o/g.git', `remote: ${value}`])
    for (const value of ['--upload-pack=touch x', '-x', 'ssh://-oProxyCommand=x/g.git', 'git@-oProxyCommand=x:o/g.git', 'ssh://%2doProxyCommand=x/g.git']) {
      refuses(remote(value), `${JSON.stringify(value)} has a "-" where git or ssh would read an option`, 'sources[0].remote')
    }
    refuses(remote('ext::sh -c x'), '"ext::sh -c x" names a remote helper of git\'s, which is not supported', 'sources[0].remote')
    refuses(edit(['  branch: main', '  ref: --output=x']), '"--output=x" starts with "-", which git reads as an option', 'sources[0].ref')
  })

  it('a glob within the source it globs the gemspecs of', () => {
    const glob = (value) => edit(['  branch: main', `  branch: main\n  glob: ${value}`])
    for (const value of ['../*.gemspec', 'a/../../*.gemspec', '{..,x}/*.gemspec', '/etc/*.gemspec', '{/etc,x}/*.gemspec', 'C:/x/*.gemspec', '{a,c:x}/*.gemspec', 'a\\..\\*.gemspec']) {
      refuses(glob(value), `${JSON.stringify(value)} reaches out of the source, which Bundler globs its gemspecs from`, 'sources[0].glob')
    }
    for (const value of ['*/*.gemspec', 'gems/**/*.gemspec', '{a,b}/x..y.gemspec', '...gemspec']) assert.equal(parseGemfileLock(glob(value)).sources[0].glob, value)
    refuses(edit(['  remote: .\n', '  remote: .\n  glob: ../*.gemspec\n']), '"../*.gemspec" reaches out of the source, which Bundler globs its gemspecs from', 'sources[1].glob')
  })

  it('a directory from the lockfile\'s', () => {
    assert.deepEqual(plain(parseGemfileLock(edit(['  remote: .\n', '  remote: ../vendor/app\n  glob: app.gemspec\n'])).sources[1]), { type: 'path', path: '../vendor/app', glob: 'app.gemspec' })
    refuses(edit(['  remote: .\n', '  remote: /home/app\n']), '"/home/app" is an absolute path, which is the path on one machine alone', 'sources[1].path')
    refuses(edit(['  remote: .\n', '  remote: ./app\n']), '"./app" is not a relative path in normal form', 'sources[1].path')
    refuses(edit(['  remote: .\n', '  remote: .\n  remote: .\n']), 'a second remote at line 11')
  })

  it('a gem server, by one URL, with a "/" at the end', () => {
    assert.equal(parseGemfileLock(edit(['https://rubygems.org/', 'https://user:secret@gems.example.com/private/'])).sources[2].remote, 'https://user:secret@gems.example.com/private/')
    refuses(edit(['https://rubygems.org/', 'https://rubygems.org']), '"https://rubygems.org" does not end in "/", as Bundler writes a source', 'sources[2].remote')
    refuses(edit(['https://rubygems.org/', 'ftp://rubygems.org/']), '"ftp://rubygems.org/" is not an http(s) URL, or a file: or s3: URL in normal form', 'sources[2].remote')
  })

  it('an S3 bucket of gems, by an s3: URL in normal form, as `source "s3://bucket/gems"` writes it', () => {
    assert.equal(parseGemfileLock(edit(['https://rubygems.org/', 's3://bucket/gems/'])).sources[2].remote, 's3://bucket/gems/')
    for (const remote of ['s3:///gems/', 'S3://bucket/gems/', 's3://bucket/a/../gems/', 's3://bucket/my gems/']) {
      refuses(edit(['https://rubygems.org/', remote]), `${JSON.stringify(remote)} is not an http(s) URL, or a file: or s3: URL in normal form`, 'sources[2].remote')
    }
    refuses(edit(['https://rubygems.org/', 's3://bucket/gems']), '"s3://bucket/gems" does not end in "/", as Bundler writes a source', 'sources[2].remote')
  })

  it('a directory of gems, by a file: URL in normal form, as `source "file:///srv/gems"` writes it', () => {
    assert.equal(parseGemfileLock(edit(['https://rubygems.org/', 'file:///srv/gems/'])).sources[2].remote, 'file:///srv/gems/')
    assert.equal(parseGemfileLock(edit(['https://rubygems.org/', 'file:///srv/my%20gems/'])).sources[2].remote, 'file:///srv/my%20gems/')
    for (const remote of ['file://localhost/srv/gems/', 'file:/srv/gems/', 'file://host/srv/gems/', 'file:///srv/my gems/', 'file:///srv/../gems/']) {
      refuses(edit(['https://rubygems.org/', remote]), `${JSON.stringify(remote)} is not an http(s) URL, or a file: or s3: URL in normal form`, 'sources[2].remote')
    }
    refuses(edit(['https://rubygems.org/', 'file:///srv/gems']), '"file:///srv/gems" does not end in "/", as Bundler writes a source', 'sources[2].remote')
    refuses(edit(['  remote: https://rubygems.org/\n', '  remote: https://rubygems.org/\n  remote: https://gem.coop/\n']), 'a second remote: Bundler fetches each gem of the source from either, and the lockfile does not say which at line 17')
    refuses(edit(['  remote: https://rubygems.org/\n', '']), 'from sources[2], which has no remote: Bundler takes it from the gems installed where it runs', 'specs["a-1.2.0"]')
  })

  it('in Bundler\'s order, as far as the lockfile says it, and a GEM source always', () => {
    const moved = (text) => {
      const git = text.slice(0, text.indexOf('PATH\n'))
      return text.replace(git, '').replace('\nGEM\n', `\n${git}GEM\n`)
    }
    refuses(moved(BASE), 'the git source "https://github.com/o/g.git" after the path source ".", where Bundler sorts them the other way at line 7')
    // Bundler sorts it by its URL less the token, which the lockfile keeps.
    assert.equal(parseGemfileLock(moved(edit(['https://github.com', 'https://user:token@github.com']))).sources[1].type, 'git')
    refuses(edit(['\nPLATFORMS\n', '\nGEM\n  specs:\n\nPLATFORMS\n']), 'a GEM source of no remote after one of a remote, where Bundler writes it first at line 24')
    assert.deepEqual(plain(parseGemfileLock(edit(['\nGEM\n', '\nGEM\n  specs:\n\nGEM\n'], ['  n (= 1.0.0)', '  n (= 1.0.0)!'])).sources[2]), { type: 'gem' })
    refuses('PLATFORMS\n  ruby\n\nDEPENDENCIES\n', 'no GEM source, which Bundler always writes')
    refuses(edit(['\nGEM\n', '\nGEM\n  specs:\n\nGEM\n  specs:\n\nGEM\n']), 'a second GEM source of no remote, where Bundler writes one, the Gemfile\'s own at line 18')
  })
})

describe('gems', () => {
  it('refuses a name, a version or a platform not as RubyGems writes it', () => {
    refuses(edit(['    a (1.2.0)', '    _a (1.2.0)']), '"_a" is not a gem name', 'specs["_a-1.2.0"]')
    refuses(edit(['    a (1.2.0)', '    a (v1.2.0)']), '"v1.2.0" is not a version as RubyGems writes one', 'specs["a-v1.2.0"]')
    refuses(edit(['    a (1.2.0)', '    a (1.2.0-ruby)']), 'the platform ruby, which Bundler leaves out of a gem of no platform', 'specs["a-1.2.0"]')
    refuses(edit(['    a (1.2.0)', '    a (1.2.0-i686-linux)']), '"i686-linux" is not a platform as RubyGems writes one', 'specs["a-1.2.0-i686-linux"]')
    refuses(edit(['  x86_64-linux\n', '  darwin-x86_64\n']), '"darwin-x86_64" is not a platform as RubyGems writes one', 'platforms[1]')
    assert.deepEqual(parseGemfileLock(edit(['  x86_64-linux\n', '  x86_64-linux\n  x86_64-linux-musl\n'])).platforms, ['ruby', 'x86_64-linux', 'x86_64-linux-musl'])
  })

  it('refuses a gem twice, out of order, or Bundler\'s own', () => {
    refuses(edit(['    a (1.2.0)\n', '    a (1.2.0)\n    a (1.2.0)\n']), 'listed twice, of which Bundler keeps the last alone, at line 19', 'specs["a-1.2.0"]')
    refuses(edit(['    a (1.2.0)\n    n (1.0.0)\n      a (~> 1.2)\n', '    n (1.0.0)\n      a (~> 1.2)\n    a (1.2.0)\n']), 'after "n-1.0.0", where Bundler sorts a source\'s gems by full name', 'specs["a-1.2.0"]')
    refuses(edit(['    a (1.2.0)\n', '    a (1.2.0)\n    bundler (2.7.2)\n']), 'Bundler itself, which Bundler leaves out of the sources', 'specs["bundler-2.7.2"]')
    refuses(edit(['  ruby\n  x86_64-linux\n', '  x86_64-linux\n  ruby\n']), '"ruby" after "x86_64-linux", where Bundler sorts the platforms, each once', 'platforms[1]')
  })

  it('a gem\'s dependencies by name, each requirement as Bundler writes it', () => {
    const where = 'specs["app-0.1.0"].dependencies.a'
    refuses(edit(['(>= 1.0, < 2)', '(>=1.0, < 2)']), '">=1.0" is not a requirement as Bundler writes one, "op version"', where)
    refuses(edit(['(>= 1.0, < 2)', '(>= 1.0,< 2)']), '">= 1.0,< 2" is not a requirement as Bundler writes one, "op version"', where)
    refuses(edit(['(>= 1.0, < 2)', '(< 2, >= 1.0)']), '">= 1.0" after "< 2", where Bundler sorts them backwards, each once', where)
    refuses(edit(['(>= 1.0, < 2)', '(>= 0)']), '">= 0", which Bundler leaves out, as any version', where)
    refuses(edit(['(>= 1.0, < 2)', '(>= 1.0-beta)']), '">= 1.0-beta" is not a requirement as Bundler writes one, "op version"', where)
    refuses(edit(['      a (~> 1.0)\n', '      b\n      a (~> 1.0)\n']), 'after "b", where Bundler sorts a gem\'s dependencies by name', 'specs["g-1.0.0"].dependencies.a')
    refuses(edit(['      a (~> 1.0)\n', '      a (~> 1.0)\n      a\n']), 'listed twice, where Bundler sorts a gem\'s dependencies by name', 'specs["g-1.0.0"].dependencies.a')
    assert.deepEqual(parseGemfileLock(edit(['(>= 1.0, < 2)', '(>= 0, < 2)'])).specs['app-0.1.0'].dependencies.a, ['>= 0', '< 2'])
  })

  it('what the Gemfile names no source of, from one default source, as Bundler takes it', () => {
    // A lone `path "."`, which Bundler 2 takes as the default source.
    assert.equal(parseGemfileLock(edit(['  app!\n', '  app\n'], ['  n (= 1.0.0)', '  n (= 1.0.0)!'])).dependencies.app.pinned, false)
    const coop = (text) => text.replace('\nGEM\n', '\nGEM\n  remote: https://gem.coop/\n  specs:\n    r (1.0.0)\n\nGEM\n').replace('  n (= 1.0.0)\n', '  n (= 1.0.0)\n  r!\n').replace(`  n (1.0.0-x86_64-linux) sha256=${H}\n`, `  n (1.0.0-x86_64-linux) sha256=${H}\n  r (1.0.0)\n`)
    assert.equal(parseGemfileLock(coop(BASE)).specs['r-1.0.0'].source, 2)
    refuses(coop(BASE).replace('  r!\n', '  r\n'), 'from sources[2], and "n" from sources[3], where Bundler takes what the Gemfile names no source of from its default alone', 'dependencies.r')
    refuses(edit(['\nGEM\n', '\nGEM\n  specs:\n\nGEM\n']), 'from sources[3], where Bundler takes what the Gemfile names no source of from its default, sources[2], of no remote', 'dependencies.n')
  })

  it('a gem of a platform one of PLATFORMS takes, as Bundler matches them', () => {
    const listed = (locked) => ['ruby', locked].sort().map((platform) => `  ${platform}\n`).join('')
    const variant = (platform, locked = 'x86_64-linux') => BASE.replaceAll('1.0.0-x86_64-linux', `1.0.0-${platform}`).replace('  ruby\n  x86_64-linux\n', listed(locked))
    const accepted = [
      ['x86_64-linux-gnu'], ['x86_64-linux', 'x86_64-linux-musl'], ['x86_64-linux-musl'], ['x86_64-linux-gnu', 'x86_64-linux-gnu'],
      ['arm-linux-gnueabihf', 'arm-linux-gnu'], ['arm-linux-eabihf', 'arm-linux-musleabihf'], ['arm64-darwin', 'arm64-darwin-23'],
      ['arm64-darwin-23', 'arm64-darwin'], ['universal-darwin', 'x86_64-darwin'], ['universal-java-11', 'java'],
      ['universal-java-11', 'universal-java-17'], ['arm-linux', 'armv7l-linux'], ['arm-linux', 'arm64-linux'], ['universal-mingw', 'x64-mingw-ucrt'],
    ]
    for (const [platform, locked] of accepted) {
      assert.equal(parseGemfileLock(variant(platform, locked)).specs[`n-1.0.0-${platform}`].platform, platform, `${platform} for ${locked}`)
    }
    refuses(edit(['  x86_64-linux\n\nDEPENDENCIES', '\nDEPENDENCIES']), 'of the platform "x86_64-linux", which no platform of PLATFORMS takes, where Bundler locks a gem for one', 'specs["n-1.0.0-x86_64-linux"]')
    for (const [platform, locked] of [['aarch64-linux'], ['x64-mingw32', 'x64-mingw-ucrt'], ['x86_64-linux-gnu', 'x86_64-linux-musl'], ['x86_64-linux-musl', 'x86_64-linux-gnu'], ['arm64-darwin-22', 'arm64-darwin-23'], ['armv7l-linux', 'arm-linux']]) {
      refuses(variant(platform, locked), `of the platform "${platform}", which no platform of PLATFORMS takes, where Bundler locks a gem for one`, `specs["n-1.0.0-${platform}"]`)
    }
  })

  it('one version of a gem for each platform', () => {
    refuses(edit(['    n (1.0.0-x86_64-linux)\n      a (~> 1.2)\n', '    n (1.0.0-x86_64-linux)\n      a (~> 1.2)\n    n (1.0.1)\n'], [`  n (1.0.0-x86_64-linux) sha256=${H}\n`, `  n (1.0.0-x86_64-linux) sha256=${H}\n  n (1.0.1) sha256=${H}\n`]), 'for the platform of "n-1.0.0", where Bundler locks one version of a gem for each', 'specs["n-1.0.1"]')
  })

  it('what the Gemfile asks for, sorted, and pinned where it names a git or path source', () => {
    refuses(edit(['  app!\n  g!\n', '  g!\n  app!\n']), 'after "g", where Bundler sorts the dependencies by name', 'dependencies.app')
    refuses(edit(['  t\n', '  t\n  t\n']), 'listed twice, where Bundler sorts the dependencies by name', 'dependencies.t')
    refuses(edit(['  g!\n', '  g\n']), 'from a git source, without the "!" Bundler writes of it', 'dependencies.g')
    refuses(edit(['  app!\n', '  app\n']), 'from sources[2], and "app" from sources[1], where Bundler takes what the Gemfile names no source of from its default alone', 'dependencies.n')
    assert.equal(parseGemfileLock(edit(['  n (= 1.0.0)', '  n (= 1.0.0)!'])).dependencies.n.pinned, true)
    refuses(edit(['  n (= 1.0.0)', '  n!(= 1.0.0)']), 'expected a dependency as "name" or "name (requirement)", found "n!(= 1.0.0)" at line 31')
  })
})

describe('the graph', () => {
  it('every dependency on gems locked under its name, which meet it, Bundler\'s own aside', () => {
    refuses(edit(['      a (~> 1.0)\n', '      a (~> 1.0)\n      b\n']), 'names no gem of the sources', 'specs["g-1.0.0"].dependencies.b')
    refuses(edit(['      a (~> 1.0)', '      a (~> 1.3)']), '"~> 1.3" is not met by "a-1.2.0"', 'specs["g-1.0.0"].dependencies.a')
    refuses(edit(['  n (= 1.0.0)', '  n (= 1.0)'], ['    n (1.0.0-x86_64-linux)', '    n (1.0.1-x86_64-linux)'], ['  n (1.0.0-x86_64-linux)', '  n (1.0.1-x86_64-linux)']), '"= 1.0" is not met by "n-1.0.1-x86_64-linux"', 'dependencies.n')
    const lock = parseGemfileLock(edit(['      a (~> 1.0)\n', '      a (~> 1.0)\n      bundler (>= 99)\n'], ['  app!\n', '  app!\n  bundler (>= 99)\n']))
    assert.deepEqual(lock.specs['g-1.0.0'].dependencies.bundler, ['>= 99'])
    assert.equal(lock.gems.bundler, undefined)
  })

  it('every gem reached from what the Gemfile asks for, and each name from one source', () => {
    refuses(edit(['  n (= 1.0.0)\n', '']), 'nothing depends on it, and Bundler locks what it resolves alone', 'specs["n-1.0.0"]')
    refuses(edit(['    app (0.1.0)\n      a (>= 1.0, < 2)\n', '    a (1.2.0)\n    app (0.1.0)\n      a (>= 1.0, < 2)\n'], ['  a (1.2.0) sha256', '  a (1.2.0)\n  a (1.2.0) sha256']), 'listed twice, of which Bundler keeps the last alone, at line 19', 'specs["a-1.2.0"]')
    refuses(edit(['      a (>= 1.0, < 2)\n', '      a (>= 1.0, < 2)\n    n (1.0.0)\n      a (~> 1.2)\n'], ['    a (1.2.0)\n    n (1.0.0)\n      a (~> 1.2)\n', '    a (1.2.0)\n']), 'from sources[2], and "n-1.0.0" from sources[1], where Bundler takes a gem from one source', 'specs["n-1.0.0-x86_64-linux"]')
  })
})

describe('checksums', () => {
  it('a line for every gem, sorted, with a sha256 of one from a server alone', () => {
    refuses(edit([`${H}\n  g (1.0.0)\n`, `${H}\n`]), 'not in CHECKSUMS, where Bundler lists every gem', 'specs["g-1.0.0"]')
    refuses(edit([`${H}\n  g (1.0.0)\n`, `${H}\n  g (1.0.0)\n  h (1.0.0)\n`]), '"h (1.0.0)" is no gem of the sources at line 39')
    refuses(edit([`${H}\n  g (1.0.0)\n`, `${H}\n  g (1.0.0)\n  g (1.0.0)\n`]), '"g (1.0.0)" after "g (1.0.0)", where Bundler sorts the checksums, each once at line 39')
    refuses(edit([`${H}\n  g (1.0.0)\n`, `${H}\n  g (1.0.0) sha256=${H}\n`]), 'a checksum of a gem from a git source, which has no .gem to check', 'specs["g-1.0.0"].checksum')
    refuses(edit([`  a (1.2.0) sha256=${H}`, `  a (1.2.0) sha512=${H}${H}`]), `"sha512=${H}${H}" is not a checksum as Bundler writes one, "sha256=" and the hex digest`, 'specs["a-1.2.0"].checksum')
    refuses(edit([`  a (1.2.0) sha256=${H}`, `  a (1.2.0) sha256=${H.toUpperCase()}`]), `"sha256=${H.toUpperCase()}" is not a checksum as Bundler writes one, "sha256=" and the hex digest`, 'specs["a-1.2.0"].checksum')
    refuses(edit(['  a (1.2.0) sha256', '   a (1.2.0) sha256']), 'expected 2 spaces of indentation, found 3 at line 35')
    refuses(edit([`  a (1.2.0) sha256=${H}\n`, `  a (1.2.0)\n  a (1.2.0) sha256=${H}\n`]), '"a (1.2.0)" a second time, where Bundler lists each gem once at line 36')
    assert.equal(parseGemfileLock(edit([`  a (1.2.0) sha256=${H}`, '  a (1.2.0)'])).specs['a-1.2.0'].checksum, undefined)
  })

  it('Bundler\'s own, with its checksum, of whichever version wrote it', () => {
    assert.deepEqual(plain(parseGemfileLock(edit(['  bundler (4.0.22)', '  bundler (4.0.17)'])).bundlerChecksum), { version: '4.0.17', checksum: `sha256=${H}` })
    assert.equal(parseGemfileLock(edit([`  bundler (4.0.22) sha256=${H}\n`, ''])).bundlerChecksum, undefined)
    refuses(edit([`  bundler (4.0.22) sha256=${H}`, '  bundler (4.0.22)']), 'Bundler itself, without the checksum Bundler writes it with at line 37')
    refuses(edit(['  bundler (4.0.22)', '  bundler (4.0.22-java)']), '"bundler (4.0.22-java)" is no gem of the sources at line 37')
  })
})

describe('Ruby and Bundler', () => {
  it('the Ruby as Bundler writes it, with an engine where not Ruby', () => {
    for (const ruby of ['ruby 3.3.6p108', 'ruby 3.4.0.preview2', 'ruby 3.3.0p-1', 'ruby 3.1.4p0 (jruby 9.4.5.0)', 'ruby 3.2.2 (truffleruby 24.1.1)']) {
      assert.equal(parseGemfileLock(edit(['  ruby 3.3.6\n', `  ${ruby}\n`])).rubyVersion, ruby)
    }
    for (const ruby of ['ruby 3.3', 'ruby  3.3.6', 'ruby 3.3.6p0108', 'ruby 3.3.6 (ruby 3.3.6)', 'jruby 9.4.5.0', 'ruby 3.3.6-p108']) {
      refuses(edit(['  ruby 3.3.6\n', `  ${ruby}\n`]), `${JSON.stringify(ruby)} is not a Ruby as Bundler writes one, "ruby 3.3.6p108"`, 'rubyVersion')
    }
  })

  it('the Bundler it was locked with', () => {
    assert.equal(parseGemfileLock(edit(['\n  4.0.22\n', '\n  4.0.0.dev\n'])).bundledWith, '4.0.0.dev')
    const stripped = parseGemfileLock(edit(['\nRUBY VERSION\n  ruby 3.3.6\n\nBUNDLED WITH\n  4.0.22\n', '']))
    assert.deepEqual([stripped.rubyVersion, stripped.bundledWith], [undefined, undefined])
    refuses(edit(['\n  4.0.22\n', '\n  4.0.22-dev\n']), '"4.0.22-dev" is not a version as RubyGems writes one', 'bundledWith')
  })
})
