import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { createVfs } from '@preventive/vfs'
import { DeptreeError, LockfileError, buildBundlerTree } from '../bundler.js'
import { bestFor, isLocked, matches, parsePlatform } from '../src/bundler/platform.js'
import { compareVersions, sameRequirements, satisfiedBy } from '../src/bundler/version.js'
import { parsePsych } from '../src/bundler/yaml.js'
import { HOST, dataEntries, gemOf, lockOf, specYaml, stubGems } from './bundler-fixture.js'
import { gathered, rawTar, slowed } from './registry.js'

const SCOPE = 'vendor/bundle/ruby/3.3.0'
const encoder = new TextEncoder()

async function build(gems, options = {}, lock = {}) {
  stubGems(gems)
  return await buildBundlerTree({ lockfile: lockOf(gems, lock), host: HOST, ...options })
}

// Each node under `at`: a directory's mode, a file's mode and text, a
// link's target.
function listing(vfs, at) {
  const out = {}
  for (const { path, type } of vfs.walk(at)) {
    const { mode } = vfs.lstat(path)
    const name = path.slice(at.length + 1) || '.'
    out[name] = type === 'directory' ? `dir ${mode.toString(8)}` : type === 'symlink' ? `-> ${vfs.readlink(path)}` : `${mode.toString(8)} ${vfs.readText(path)}`.trimEnd()
  }
  return out
}

describe('buildBundlerTree', () => {
  it('writes each gem\'s .gem and directory as Bundler installs them under BUNDLE_PATH', async () => {
    const files = {
      'lib/a.rb': 'a',
      'bin/tool': '#!/usr/bin/env ruby\n',
      'exe/run': { data: 'run', mode: 0o755 },
      secret: { data: 's', mode: 0o600 },
      group: { data: 'g', mode: 0o664 },
      all: { data: 'x', mode: 0o777 },
      ro: { data: 'r', mode: 0o444 },
      'lib/link.rb': { type: 'symlink', linkname: 'a.rb' },
      'lib/dangling.rb': { type: 'symlink', linkname: 'nowhere.rb' },
      'nested/': { type: 'directory', mode: 0o750 },
      'deep/er/': { type: 'directory', mode: 0o700 },
      'deep/er/f': 'f',
      '.hidden': 'h',
    }
    const a = await gemOf({ name: 'a', version: '1.0.0', executables: ['tool'], deps: [['b', [['~>', '1.0']]]], homepage: 'https://a.example', metadata: { source_code_uri: 'https://github.com/o/a' } }, { files })
    const b = await gemOf({ name: 'b', version: '1.0.1', executables: ['missing'] })
    const { vfs, stats, installed, skipped } = await build([a, b], {}, { dependencies: ['a'] })
    assert.deepEqual(vfs.readdir(`/${SCOPE}`), ['cache', 'gems'])
    assert.deepEqual(vfs.readdir(`/${SCOPE}/cache`), ['a-1.0.0.gem', 'b-1.0.1.gem'])
    assert.deepEqual(vfs.readFile(`/${SCOPE}/cache/a-1.0.0.gem`), a.bytes)
    assert.equal(vfs.lstat(`/${SCOPE}/cache/a-1.0.0.gem`).mode, 0o644)
    // A file's mode as the umask leaves it, an executable's made so; a
    // directory's of its own entry, those on the way to it too; a link to
    // nothing left out, its directory made all the same.
    assert.deepEqual(listing(vfs, `/${SCOPE}/gems/a-1.0.0`), {
      '.': 'dir 755',
      '.hidden': '644 h',
      all: '755 x',
      bin: 'dir 755',
      'bin/tool': '755 #!/usr/bin/env ruby',
      deep: 'dir 700',
      'deep/er': 'dir 700',
      'deep/er/f': '644 f',
      exe: 'dir 755',
      'exe/run': '755 run',
      group: '644 g',
      lib: 'dir 755',
      'lib/a.rb': '644 a',
      'lib/link.rb': '-> a.rb',
      nested: 'dir 750',
      ro: '444 r',
      secret: '600 s',
    })
    assert.deepEqual(stats, { specs: 2, installed: 2, files: 12, bytes: stats.bytes, links: 1 })
    assert.deepEqual(installed, [
      { path: `${SCOPE}/gems/a-1.0.0`, name: 'a', version: '1.0.0', platform: 'ruby', source: 'https://rubygems.org/', checksum: a.checksum, homepage: 'https://a.example', sourceCodeUri: 'https://github.com/o/a' },
      { path: `${SCOPE}/gems/b-1.0.1`, name: 'b', version: '1.0.1', platform: 'ruby', source: 'https://rubygems.org/', checksum: b.checksum, homepage: undefined, sourceCodeUri: undefined },
    ])
    assert.deepEqual(skipped, [])
  })

  it('makes executable what an executable links to, and a link after a link it is made after', async () => {
    const files = { 'lib/tool.rb': 'tool', 'bin/tool': { type: 'symlink', linkname: '../lib/tool.rb' }, 'one': { type: 'symlink', linkname: 'lib/tool.rb' }, 'two': { type: 'symlink', linkname: 'one' }, 'early': { type: 'symlink', linkname: 'late' }, 'late': { type: 'symlink', linkname: 'lib' } }
    const { vfs } = await build([await gemOf({ name: 'x', version: '1.0.0', executables: ['tool'] }, { files })])
    const at = `/${SCOPE}/gems/x-1.0.0`
    assert.equal(vfs.lstat(`${at}/lib/tool.rb`).mode, 0o755)
    // `early` leads to `late`, which is not made yet when `early` is.
    assert.deepEqual([vfs.readlink(`${at}/two`), vfs.readlink(`${at}/late`), vfs.isSymlink(`${at}/early`)], ['one', 'lib', false])
  })

  it('takes BUNDLE_PATH as given or from .bundle/config, and refuses another', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    stubGems([leaf])
    const lockfile = lockOf([leaf])
    assert.deepEqual((await buildBundlerTree({ lockfile, host: HOST, path: '.bundle' })).vfs.readdir('/.bundle/ruby/3.3.0'), ['cache', 'gems'])
    const read = (files, path) => buildBundlerTree({ project: createVfs({ Gemfile: '', 'Gemfile.lock': lockfile, ...files }), host: HOST, path })
    assert.deepEqual((await read({ '.bundle/config': '---\nBUNDLE_PATH: "gems/here"\nBUNDLE_JOBS: "4"\n' })).installed[0].path, 'gems/here/ruby/3.3.0/gems/leaf-1.0.0')
    assert.deepEqual((await read({ '.bundle/config': '---\nBUNDLE_PATH: vendor/x\n' })).installed[0].path, 'vendor/x/ruby/3.3.0/gems/leaf-1.0.0')
    assert.deepEqual((await read({ '.bundle/config': '' })).installed[0].path, `${SCOPE}/gems/leaf-1.0.0`)
    assert.deepEqual((await read({ '.bundle/config': '---\nBUNDLE_PATH: "vendor/x"\n' }, 'vendor/x')).installed[0].path, 'vendor/x/ruby/3.3.0/gems/leaf-1.0.0')
    await assert.rejects(read({ '.bundle/config': '---\nBUNDLE_PATH: "vendor/x"\n' }, 'vendor/y'), /^DeptreeError: \.bundle\/config: BUNDLE_PATH is "vendor\/x", where Bundler installs, not "vendor\/y"$/u)
    await assert.rejects(read({ '.bundle/config': '---\nBUNDLE_WITHOUT: "test"\n' }), /^DeptreeError: \.bundle\/config: BUNDLE_WITHOUT: not supported: it may change what Bundler installs, and is not read here$/u)
    await assert.rejects(read({ '.bundle/config': 'BUNDLE_PATH: "x"\n' }), /^DeptreeError: \.bundle\/config: expected `---` first, as Bundler writes it$/u)
    await assert.rejects(read({ '.bundle/config': '---\nBUNDLE_PATH: "x" # y\n' }), /is no setting as Bundler writes one$/u)
    for (const path of ['/abs', '../up', 'a/../b', '~/gems', 'a//b', '.', 'a\\b']) {
      if (!path.includes('\\')) await assert.rejects(read({ '.bundle/config': `---\nBUNDLE_PATH: "${path}"\n` }), /BUNDLE_PATH: ".*" is not a path within the project, as it is read here$/u, path)
      await assert.rejects(buildBundlerTree({ lockfile, host: HOST, path }), /^DeptreeError: path: /u, path)
    }
    await assert.rejects(read({ 'real/config': '---\n', '.bundle': { type: 'symlink', target: 'real' } }), /^DeptreeError: "\.bundle": a link where Bundler reads a file is not supported$/u)
  })

  it('reads gems.locked where gems.rb is, as Bundler finds it first, and refuses a project with no Gemfile or lockfile', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    stubGems([leaf])
    const lockfile = lockOf([leaf])
    const read = (files) => buildBundlerTree({ project: createVfs(files), host: HOST })
    assert.equal((await read({ 'gems.rb': '', 'gems.locked': lockfile, Gemfile: '', 'Gemfile.lock': 'x' })).stats.installed, 1)
    await assert.rejects(read({ 'gems.rb': '', 'Gemfile.lock': lockfile }), /^DeptreeError: the project has no gems\.locked, without which Bundler resolves every gem anew$/u)
    await assert.rejects(read({ 'Gemfile.lock': lockfile }), /^DeptreeError: the project has no Gemfile, as gems\.rb or Gemfile, without which Bundler installs nothing$/u)
    await assert.rejects(read({ Gemfile: '', 'real.lock': lockfile, 'Gemfile.lock': { type: 'symlink', target: 'real.lock' } }), /^DeptreeError: "Gemfile\.lock": a link where Bundler reads a file is not supported$/u)
  })

  it('mounts the tree into the Vfs given, and refuses one that has the path already', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    stubGems([leaf])
    const project = createVfs({ Gemfile: '', 'Gemfile.lock': lockOf([leaf]), 'vendor/cache/x': 'x' })
    const { vfs } = await buildBundlerTree({ project, host: HOST, vfs: project })
    assert.equal(vfs, project)
    assert.deepEqual(project.readdir('/vendor'), ['bundle', 'cache'])
    await assert.rejects(buildBundlerTree({ project, host: HOST, vfs: project }), /^DeptreeError: vfs\["\/vendor\/bundle"\]: "vendor\/bundle" is there already, which Bundler takes what is in as installed$/u)
    const folded = createVfs({ Gemfile: '', 'Gemfile.lock': lockOf([leaf]), 'Vendor/Bundle': { type: 'directory' } })
    await assert.rejects(buildBundlerTree({ project: folded, host: { ...HOST, platform: 'arm64-darwin-23', os: 'darwin' }, vfs: folded }), /^DeptreeError: vfs\["\/Vendor\/Bundle"\]: /u)
  })

  it('writes nothing where no gem is installed', async () => {
    const calls = stubGems([])
    const lockfile = 'PATH\n  remote: .\n  specs:\n    app (0.1.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n\nPLATFORMS\n  ruby\n  x86_64-linux\n\nDEPENDENCIES\n  app!\n'
    const { vfs, stats, installed } = await buildBundlerTree({ lockfile, host: HOST })
    assert.deepEqual([vfs.readdir('/'), stats, installed, calls], [[], { specs: 1, installed: 0, files: 0, bytes: 0, links: 0 }, [], []])
  })
})

// Four of a name, of no platform, of x86_64-linux's, of arm64-darwin's and
// of x86_64-linux-musl's.
async function variants() {
  return await Promise.all(['ruby', 'x86_64-linux', 'arm64-darwin', 'x86_64-linux-musl'].map((platform) => gemOf({ name: 'n', version: '1.0.0', platform }, { files: { [`lib/${platform}.rb`]: platform } })))
}
const PLATFORMS = ['arm64-darwin', 'ruby', 'x86_64-linux', 'x86_64-linux-musl']

describe('the gems of a platform', () => {
  it('installs the one most specific to the machine of those installable there, `ruby` the least', async () => {
    const gems = await variants()
    const keyOn = async (platform, os = 'linux') => (await build(gems, { host: { ...HOST, platform, os } }, { platforms: PLATFORMS })).installed.map(({ platform: own }) => own)
    assert.deepEqual(await keyOn('x86_64-linux'), ['x86_64-linux'])
    assert.deepEqual(await keyOn('x86_64-linux-musl'), ['x86_64-linux-musl'])
    assert.deepEqual(await keyOn('arm64-darwin-23', 'darwin'), ['arm64-darwin'])
    assert.deepEqual(await keyOn('aarch64-linux'), ['ruby'])
    assert.deepEqual(await keyOn('x86_64-darwin-22', 'darwin'), ['ruby'])
    // A glibc gem on musl, as Gem::Platform#=== takes it.
    assert.deepEqual(await keyOn('x86_64-linux-musl'), ['x86_64-linux-musl'])
    const noMusl = gems.filter(({ platform }) => platform !== 'x86_64-linux-musl')
    assert.deepEqual((await build(noMusl, { host: { ...HOST, platform: 'x86_64-linux-musl' } }, { platforms: PLATFORMS.slice(0, 3) })).installed.map(({ platform }) => platform), ['x86_64-linux'])
  })

  it('refuses what Bundler resolves anew: no platform of PLATFORMS the machine\'s, none of a gem\'s installable there, `ruby` alone', async () => {
    const gems = await variants()
    const linux = gems.filter(({ platform }) => platform === 'x86_64-linux')
    await assert.rejects(build(linux, { host: { ...HOST, platform: 'aarch64-linux' } }, { platforms: ['x86_64-linux'] }), /^DeptreeError: none of PLATFORMS is "aarch64-linux", which Bundler adds and resolves every gem for anew$/u)
    await assert.rejects(build(linux, { host: { ...HOST, platform: 'aarch64-linux' } }, { platforms: ['aarch64-linux', 'x86_64-linux'] }), /^DeptreeError: gems\["n"\]: no gem of it is of a platform "aarch64-linux" takes, for which Bundler resolves anew$/u)
    await assert.rejects(build(gems.filter(({ platform }) => platform === 'ruby'), {}, { platforms: ['ruby'] }), /^DeptreeError: PLATFORMS has `ruby` alone, for which Bundler takes the platform of each gem from what rubygems\.org has, which is not supported$/u)
    // musl takes a glibc platform's gem, and not the other way: Bundler 2.5
    // and 2.6 read the one each way.
    await assert.rejects(build(gems.filter(({ platform }) => platform === 'x86_64-linux-musl'), {}, { platforms: ['x86_64-linux-musl'] }), /none of PLATFORMS is "x86_64-linux"/u)
  })

  it('refuses two gems as specific to the machine, of which Bundler installs either or both', () => {
    const machine = parsePlatform('arm64-darwin-23')
    const { tied } = bestFor([{ key: 'a', platform: parsePlatform('arm64-darwin-21') }, { key: 'b', platform: parsePlatform('arm64-darwin') }, { key: 'c', platform: parsePlatform('universal-darwin') }], machine)
    assert.equal(tied, undefined)
    const two = bestFor([{ key: 'a', platform: parsePlatform('x86_64-linux-gnu') }, { key: 'b', platform: parsePlatform('x86_64-linux-gnueabi') }], parsePlatform('x86_64-linux'))
    assert.deepEqual(two.tied.map(({ key }) => key), ['a', 'b'])
  })
})

describe('Gem::Platform, as RubyGems 3.5 to 4.0 read and match it', () => {
  it('reads a platform both readings take as written, and no other', () => {
    assert.deepEqual(parsePlatform('x86_64-linux'), { cpu: 'x86_64', os: 'linux', version: undefined })
    assert.deepEqual(parsePlatform('arm64-darwin-23'), { cpu: 'arm64', os: 'darwin', version: '23' })
    assert.deepEqual(parsePlatform('aarch64-linux-musl'), { cpu: 'aarch64', os: 'linux', version: 'musl' })
    assert.deepEqual(parsePlatform('universal-java-17'), { cpu: 'universal', os: 'java', version: '17' })
    for (const text of ['ruby', 'arm64-darwin23', 'i686-linux', 'x86_64-linux-', 'x86_64-darwin-23-x', 'a b', '']) assert.equal(parsePlatform(text), undefined, text)
  })

  it('matches a gem\'s platform to the machine\'s as Gem::Platform#=== does, not commutatively', () => {
    const p = (text) => parsePlatform(text)
    assert.equal(matches(p('x86_64-linux'), p('x86_64-linux-musl')), true)
    assert.equal(matches(p('x86_64-linux-musl'), p('x86_64-linux')), false)
    assert.equal(matches(p('x86_64-linux-gnu'), p('x86_64-linux')), true)
    assert.equal(matches(p('arm-linux'), p('armv7l-linux')), true)
    assert.equal(matches(p('universal-darwin'), p('arm64-darwin-23')), true)
    assert.equal(matches(p('arm64-darwin-22'), p('arm64-darwin-23')), false)
    assert.equal(matches(p('x86_64-darwin'), p('arm64-darwin-23')), false)
    assert.equal(isLocked([p('x86_64-linux-gnu')], p('x86_64-linux')), true)
    assert.equal(isLocked([p('x86_64-linux-musl')], p('x86_64-linux')), false)
    assert.equal(isLocked(['ruby'], p('x86_64-linux')), true)
  })
})

describe('Gem::Version and Gem::Requirement', () => {
  it('compare as RubyGems 3.5 compares them', () => {
    assert.equal(compareVersions('1.0', '1.0.0'), 0)
    assert.equal(compareVersions('1.0.a', '1.0'), -1)
    assert.equal(compareVersions('1.10', '1.9'), 1)
    assert.equal(compareVersions('1.0.0.a1', '1.0.a.1'), 0)
    assert.equal(satisfiedBy('3.3.6', [['>=', '3.0'], ['<', '3.4.dev']]), true)
    assert.equal(satisfiedBy('3.4.0', [['>=', '3.0'], ['<', '3.4.dev']]), false)
    assert.equal(satisfiedBy('3.3.6', [['~>', '3.3']]), true)
    assert.equal(satisfiedBy('4.0.0', [['~>', '3.3']]), false)
    assert.equal(satisfiedBy('3.3.6', [['~>', '3.2.0']]), false)
    assert.equal(sameRequirements([['>=', '1'], ['<', '2']], [['<', '2.0'], ['>=', '1.0']]), true)
    assert.equal(sameRequirements([['~>', '1.0']], [['~>', '1.0.0']]), false)
    assert.equal(sameRequirements([['>=', '1']], [['>', '1']]), false)
  })
})

describe('a gem, held to the lockfile', () => {
  it('refuses a .gem of another name, version or platform, or of other runtime dependencies', async () => {
    const b = await gemOf({ name: 'b', version: '1.0.0' })
    const refused = async (spec, pattern, deps = []) => {
      const a = { ...await gemOf({ name: 'a', version: '1.0.0', deps }, { yaml: specYaml(spec) }), deps }
      await assert.rejects(build([a, b], {}, { dependencies: ['a', 'b'] }), pattern)
    }
    await refused({ name: 'z', version: '1.0.0' }, /^DeptreeError: specs\["a-1\.0\.0"\]: its \.gem is of the name "z", not "a"$/u)
    await refused({ name: 'a', version: '1.0' }, /: its \.gem is of the version "1\.0", not "1\.0\.0"$/u)
    await refused({ name: 'a', version: '1.0.0', platform: 'x86_64-linux' }, /: its \.gem is of the platform "x86_64-linux", not "ruby"$/u)
    await refused({ name: 'a', version: '1.0.0', deps: [['b', [['>=', '1']]]] }, /: its \.gem depends on "b" by ">= 1", the lockfile by nothing, for which Bundler resolves anew$/u)
    await refused({ name: 'a', version: '1.0.0' }, /: its \.gem depends on "b" by nothing, the lockfile by "~> 1\.0", for which Bundler resolves anew$/u, [['b', [['~>', '1.0']]]])
    await refused({ name: 'a', version: '1.0.0', deps: [['b', [['~>', '1.0.0']]]] }, /: its \.gem depends on "b" by "~> 1\.0\.0", the lockfile by "~> 1\.0"/u, [['b', [['~>', '1.0']]]])
    // A development dependency is not held to it, and requirements are
    // equal as Gem::Requirement#== has them.
    const a = { ...await gemOf({ name: 'a', version: '1.0.0', deps: [['b', [['<', '2'], ['>=', '1.0']]], ['c', [['>=', '0']], 'development']] }), deps: [['b', [['>=', '1'], ['<', '2.0']]]] }
    assert.equal((await build([a, b], {}, { dependencies: ['a'] })).stats.installed, 2)
  })

  it('refuses a gem for a Ruby or a RubyGems the machine\'s is not', async () => {
    const ruby = await gemOf({ name: 'a', version: '1.0.0', requiredRuby: [['>=', '3.0'], ['<', '3.3.dev']] })
    await assert.rejects(build([ruby]), /^DeptreeError: specs\["a-1\.0\.0"\]: it requires Ruby >= 3\.0, < 3\.3\.dev, which Ruby 3\.3\.6 does not meet, for which Bundler takes another gem or resolves anew$/u)
    assert.equal((await build([ruby], { host: { ...HOST, ruby: '3.2.4' } })).stats.installed, 1)
    await assert.rejects(build([await gemOf({ name: 'a', version: '1.0.0', requiredRubygems: [['>=', '3.6']] })]), /: it requires RubyGems >= 3\.6, which RubyGems 3\.5\.22 does not meet/u)
  })

  it('refuses a gem with extensions, or from git, or with `partial` skips it, and refuses one from another remote', async () => {
    const ext = await gemOf({ name: 'ext', version: '1.0.0', extensions: ['ext/x/extconf.rb'] })
    const plain = await gemOf({ name: 'plain', version: '1.0.0' })
    const C = 'c'.repeat(40)
    const sources = `GIT\n  remote: https://github.com/o/g.git\n  revision: ${C}\n  specs:\n    g (1.0.0)\n      plain\n\n`
    const lock = { sources, others: [{ name: 'g', version: '1.0.0', platform: 'ruby', deps: [['plain', [['>=', '0']]]] }], dependencies: ['ext', 'g!'] }
    const refused = /^DeptreeError: specs\["ext-1\.0\.0"\]: a gem with extensions to build, "ext\/x\/extconf\.rb", whose directory holds what they make, is not supported$/u
    await assert.rejects(build([ext], {}, {}), refused)
    await assert.rejects(build([ext, plain], {}, lock), /^DeptreeError: specs\["g-1\.0\.0"\]: a gem from git, "https:\/\/github\.com\/o\/g\.git", which Bundler checks out with git, is not supported$/u)
    const { vfs, installed, skipped, stats } = await build([ext, plain], { partial: true }, lock)
    assert.deepEqual(installed.map(({ name }) => name), ['plain'])
    assert.deepEqual(vfs.readdir(`/${SCOPE}/gems`), ['plain-1.0.0'])
    assert.deepEqual(skipped, [
      { name: 'g', version: '1.0.0', platform: 'ruby', reason: 'specs["g-1.0.0"]: a gem from git, "https://github.com/o/g.git", which Bundler checks out with git, is not supported', paths: [`${SCOPE}/bundler/gems`, `${SCOPE}/cache/bundler/git`] },
      { name: 'ext', version: '1.0.0', platform: 'ruby', reason: 'specs["ext-1.0.0"]: a gem with extensions to build, "ext/x/extconf.rb", whose directory holds what they make, is not supported', paths: [`${SCOPE}/gems/ext-1.0.0`, `${SCOPE}/cache/ext-1.0.0.gem`] },
    ])
    assert.equal(stats.installed, 1)
    const other = lockOf([plain]).replace('https://rubygems.org/', 'https://gems.example/')
    stubGems([plain])
    await assert.rejects(buildBundlerTree({ lockfile: other, host: HOST, partial: true }), /^DeptreeError: specs\["plain-1\.0\.0"\]: a gem from "https:\/\/gems\.example\/" is not supported: only those from https:\/\/rubygems\.org\/ are$/u)
  })

  it('installs a path gem nowhere, but the gems it depends on', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    const sources = 'PATH\n  remote: .\n  specs:\n    app (0.1.0)\n      leaf (~> 1.0)\n\n'
    const { installed } = await build([leaf], {}, { sources, others: [{ name: 'app', version: '0.1.0', platform: 'ruby', deps: [['leaf', [['~>', '1.0']]]] }], dependencies: ['app'] })
    assert.deepEqual(installed.map(({ name }) => name), ['leaf'])
  })

  it('is held to the lockfile\'s checksum, or else rubygems.org\'s', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    const other = await gemOf({ name: 'leaf', version: '1.0.0' }, { files: { 'lib/b.rb': 'b' } })
    await assert.rejects(build([{ ...leaf, served: other.bytes }]), /^DeptreeError: specs\["leaf-1\.0\.0"\]: /u)
    const calls = stubGems([leaf])
    const { installed } = await buildBundlerTree({ lockfile: lockOf([leaf], { checksums: false }), host: HOST })
    assert.equal(installed[0].checksum, leaf.checksum)
    assert.deepEqual(calls, ['https://index.rubygems.org/info/leaf', 'https://rubygems.org/gems/leaf-1.0.0.gem'])
  })

  it('refuses a lockfile BUNDLED WITH another Bundler, which Bundler installs into the path and switches to', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    await assert.rejects(build([leaf], {}, { bundled: '2.6.9' }), /^DeptreeError: host\.bundler: the lockfile is BUNDLED WITH 2\.6\.9, which Bundler 4\.0\.18 installs into the path and switches to$/u)
    assert.equal((await build([leaf], { host: { ...HOST, bundler: '2.6.9' } }, { bundled: '2.6.9' })).stats.installed, 1)
    assert.equal((await build([leaf], { host: { ...HOST, bundler: '2.7.2' } }, { bundled: null })).stats.installed, 1)
  })
})

// A .gem of these outer entries, as given.
const outer = (members) => gemOf({ name: 'o', version: '1.0.0' }, { members })

describe('a .gem', () => {
  const refused = async (made, pattern) => assert.rejects(build([await made]), pattern)

  it('is a tar of metadata.gz, data.tar.gz and checksums.yaml.gz, each once, and a .sig of any', async () => {
    const good = await gemOf({ name: 'o', version: '1.0.0' })
    const member = (name, data, fields = {}) => ({ name, data, mode: 0o444, ...fields })
    assert.equal((await build([await outer([member('metadata.gz', good.metadata), member('data.tar.gz', good.data), member('data.tar.gz.sig', encoder.encode('sig'))])])).stats.installed, 1)
    await refused(outer([member('data.tar.gz', good.data)]), /^DeptreeError: specs\["o-1\.0\.0"\]: the \.gem has no metadata\.gz, which RubyGems refuses$/u)
    await refused(outer([member('metadata.gz', good.metadata)]), /: the \.gem has no data\.tar\.gz, which RubyGems refuses$/u)
    await refused(outer([member('metadata.gz', good.metadata), member('data.tar.gz', good.data), member('README', encoder.encode('r'))]), /: "README": a file of a \.gem RubyGems does not write$/u)
    await refused(outer([member('metadata', encoder.encode(specYaml({ name: 'o', version: '1.0.0' }))), member('data.tar.gz', good.data)]), /: "metadata": a file of a \.gem RubyGems does not write$/u)
    await refused(outer([member('metadata.gz', good.metadata), member('data.tar.gz', good.data), { name: 'checksums.yaml.gz', type: 'symlink', linkname: 'data.tar.gz' }]), /: "checksums\.yaml\.gz": a symlink, where RubyGems writes a file$/u)
    const twice = pack([member('metadata.gz', good.metadata), member('data.tar.gz', good.data)], { format: 'ustar' })
    const doubled = new Uint8Array([...twice.subarray(0, twice.length - 10240), ...twice.subarray(512, 1024 + 512 * Math.ceil(good.metadata.length / 512) - 512), ...twice.subarray(twice.length - 10240)])
    await assert.rejects(build([{ ...good, bytes: doubled, served: doubled, checksum: (await import('./registry.js')).sha256(doubled) }]), /: the \.gem cannot be read: |: "metadata\.gz": twice in the \.gem/u)
  })

  it('holds each file to checksums.yaml.gz', async () => {
    const good = await gemOf({ name: 'o', version: '1.0.0' })
    const sums = (text) => gemOf({ name: 'o', version: '1.0.0' }, { checksums: text })
    await refused(sums(`---\nSHA256:\n  data.tar.gz: ${'f'.repeat(64)}\n`), /^DeptreeError: specs\["o-1\.0\.0"\]: checksums\.yaml\.gz: the SHA256 of "data\.tar\.gz" is not the one it has$/u)
    // Digits alone, which Psych reads as an integer.
    await refused(sums(`---\nSHA256:\n  data.tar.gz: ${'0'.repeat(64)}\n`), /: checksums\.yaml\.gz: SHA256\.data\.tar\.gz is no string$/u)
    await refused(sums('---\nSHA256:\n  missing.gz: abc\n'), /: checksums\.yaml\.gz: "missing\.gz" is no file of the \.gem that RubyGems digests$/u)
    await refused(sums('---\nMD5:\n  data.tar.gz: abc\n'), /: checksums\.yaml\.gz: "MD5" is no digest RubyGems writes$/u)
    await refused(sums('--- []\n'), /: checksums\.yaml\.gz: it is no mapping of algorithms$/u)
    await refused(sums('---\nSHA256:\n  data.tar.gz: 1234\n'), /: checksums\.yaml\.gz: SHA256\.data\.tar\.gz is no string$/u)
    // Uppercase hex, which Digest#hexdigest is never.
    const upper = (await import('./registry.js')).sha256(good.data).toUpperCase()
    await refused(sums(`---\nSHA256:\n  data.tar.gz: ${upper}\n`), /the SHA256 of "data\.tar\.gz" is not the one it has/u)
    assert.equal((await build([await sums('--- {}\n')])).stats.installed, 1)
  })

  it('reads each gzipped member as Zlib reads one', async () => {
    const good = await gemOf({ name: 'o', version: '1.0.0' })
    const member = (name, data) => ({ name, data, mode: 0o444 })
    const withData = (data) => outer([member('metadata.gz', good.metadata), member('data.tar.gz', data)])
    await refused(withData(new Uint8Array([...good.data, ...good.data])), /: data\.tar\.gz is not one gzip member, of which Zlib reads the first alone$/u)
    const crc = new Uint8Array(good.data)
    crc[3] |= 0x02
    await refused(withData(crc), /: data\.tar\.gz has a gzip flag Zlib refuses$/u)
    const trailer = new Uint8Array(good.data)
    trailer[trailer.length - 5] ^= 1
    await refused(withData(trailer), /: data\.tar\.gz's gzip trailer does not match its data$/u)
    await refused(withData(encoder.encode('not gzip at all, no')), /: data\.tar\.gz is not gzipped$/u)
    await refused(outer([member('metadata.gz', await compress(new Uint8Array([0xff, 0xfe]), 'gzip')), member('data.tar.gz', good.data)]), /: metadata\.gz is not UTF-8, which Psych refuses$/u)
  })

  it('reads data.tar as RubyGems\' TarReader and @preventive/archive both do', async () => {
    const tar = (entries) => gemOf({ name: 'o', version: '1.0.0' }, { tar: entries })
    await refused(tar(pack(dataEntries({ [`${'d'.repeat(120)}/f`]: 'f' }), { format: 'gnu' })), /: data\.tar\.gz: "d{120}\/f": an extended header, which RubyGems reads as an entry of its own$/u)
    await refused(tar(pack(dataEntries({ [`${'d'.repeat(120)}`]: 'f' }), { format: 'pax' })), /: an extended header, which RubyGems reads as an entry of its own$/u)
    // A name ending in a space, which TarHeader's unpack('A') drops.
    await refused(tar(rawTar([{ name: 'lib/a.rb ', data: 'a' }])), /: "lib\/a\.rb ": a header RubyGems reads otherwise than tar$/u)
    await refused(tar(rawTar([{ name: 'lib/a.rb\0x', data: 'a' }])), /: data\.tar\.gz: "lib\/a\.rb": a name with a NUL in it, which RubyGems refuses$/u)
    await refused(tar(rawTar([{ name: 'hard', data: '', type: '1' }])), /: data\.tar\.gz cannot be read: |a hardlink, which RubyGems makes nothing of but its directory/u)
    await refused(tar(pack(dataEntries({}, [{ name: 'fifo', type: 'fifo' }]), { format: 'ustar' })), /: "fifo": a fifo, which RubyGems makes nothing of but its directory$/u)
    await refused(tar(rawTar([{ name: 'a\\b', data: 'a' }])), /: data\.tar\.gz cannot be read: /u)
    // A ustar prefix, which full_name joins with a `/`, as tar does.
    const long = `${'p'.repeat(90)}/${'n'.repeat(90)}`
    const { vfs } = await build([await tar(pack(dataEntries({ [long]: 'x' }), { format: 'ustar' }))])
    assert.equal(vfs.readText(`/${SCOPE}/gems/o-1.0.0/${long}`), 'x')
  })

  it('bounds what data.tar.gz unpacks to', async () => {
    const big = await gemOf({ name: 'o', version: '1.0.0' }, { files: { zeros: new Uint8Array(1024 * 1024) } })
    assert.ok(big.bytes.length * 20 < 1024 * 1024)
    assert.equal((await build([big])).stats.installed, 1)
  })
})

describe('extract_tar_gz, as RubyGems does it', () => {
  const extracted = async (files, spec = {}, host = HOST) => (await build([await gemOf({ name: 'x', version: '1.0.0', ...spec }, { files })], { host })).vfs
  const refused = (files, pattern, spec = {}) => assert.rejects(extracted(files, spec), pattern)

  it('refuses what RubyGems removes first or fails to make', async () => {
    await refused({ 'lib/a.rb': 'a', 'lib/': { type: 'directory', mode: 0o755 } }, /^DeptreeError: specs\["x-1\.0\.0"\]: "lib\/": a directory where RubyGems has made a directory already, which it removes first$/u)
    await refused({ '~x': 'a' }, /: "~x": a name RubyGems reads as outside the gem's directory, which it refuses$/u)
    await refused({ l: { type: 'symlink', linkname: '~/x' } }, /: "l": a link RubyGems reads as leading out of the gem's directory, which it refuses$/u)
    await refused({ 'd/l': { type: 'symlink', linkname: '..' } }, /: "d\/l": a link leading out of the gem's directory, which RubyGems refuses$/u)
    await refused({ l: { type: 'symlink', linkname: '.' } }, /: "l": a link leading out of the gem's directory, which RubyGems refuses$/u)
    await refused({ tool: 'x', 'bin/x': 'x' }, /: its executable "\.\.\/\.\.\/tool" in "bin" leads out of its directory$/u, { executables: ['../../tool'] })
    // Through a directory that is not there, the kernel finds nothing.
    await extracted({ tool: 'x' }, { executables: ['../../tool'] })
    // One that leads back in, through its bindir's parent, is made executable.
    assert.equal((await extracted({ tool: 'x', 'bin/x': 'x' }, { executables: ['../tool'] })).lstat(`/${SCOPE}/gems/x-1.0.0/tool`).mode, 0o755)
  })

  it('refuses a link twice, which RubyGems fails to make again', async () => {
    const link = { name: 'l', type: 'symlink', linkname: 'lib/a.rb' }
    await assert.rejects(build([await gemOf({ name: 'x', version: '1.0.0' }, { entries: [link, link] })]), /: "l": a link twice, which RubyGems fails to make again$/u)
  })

  it('refuses a special bit, which RubyGems 4.0.24 drops and those before keep', async () => {
    await refused({ suid: { data: 's', mode: 0o4755 } }, /: "suid": mode 4755, of a setuid, setgid or sticky bit, which RubyGems 4\.0\.24 drops and those before keep, is not supported$/u)
    await refused({ 'd/': { type: 'directory', mode: 0o1777 } }, /: "d\/": mode 1777, of a setuid/u)
  })

  it('refuses what RubyGems fails on as any user but root', async () => {
    await refused({ 'ro/': { type: 'directory', mode: 0o555 }, 'ro/x': 'x' }, /: "ro\/x": mode 555 of "ro", which keeps RubyGems from making what is in it as any user but root, is not supported$/u)
    await refused({ 'a/b/': { type: 'directory', mode: 0o500 } }, /: "a\/b\/": mode 500 of "a", which keeps RubyGems from making/u)
    const vfs = await extracted({ 'empty/': { type: 'directory', mode: 0o500 } })
    assert.equal(vfs.lstat(`/${SCOPE}/gems/x-1.0.0/empty`).mode, 0o500)
  })

  it('refuses on macOS two names that are one there', async () => {
    const files = { 'A.rb': 'a', 'a.rb': 'b' }
    await extracted(files)
    await assert.rejects(extracted(files, {}, { ...HOST, platform: 'arm64-darwin-23', os: 'darwin' }), /a file where RubyGems has made a file already, which it removes first|are one name on macOS/u)
  })
})

describe('the YAML of a spec, as Psych reads it', () => {
  const read = (text) => parsePsych(text, 'yaml')
  const value = (node) => (node.kind === 'map' ? Object.fromEntries([...node.entries].map(([key, item]) => [key, value(item)])) : node.kind === 'seq' ? node.items.map(value) : node.type === 'string' ? node.value : `${node.type} ${node.value}`)

  it('reads what Psych writes: folded flow scalars, block scalars, indentless sequences, anchors', () => {
    assert.deepEqual(value(read('---\na: one\n  two\n\n  three\nb: "x\\ty\n  \\ z\\u00e9"\nc: |2-\n    lead\n  next\nd:\n- - "~>"\n  - x\ne: &1\n  k: v\nf: *1\n? "long"\n: v\ng: >\n  a\n  b\n\n  c\nh: \'it\'\'s\'\n')), {
      a: 'one two\nthree',
      b: 'x\ty  zé',
      c: '  lead\nnext',
      d: [['~>', 'x']],
      e: { k: 'v' },
      f: { k: 'v' },
      long: 'v',
      g: 'a b\nc\n',
      h: "it's",
    })
    assert.deepEqual(value(read('--- !ruby/object:Gem::Version\nversion: 1.0\n')), { version: 'float 1.0' })
    assert.equal(read('---\nk: :runtime\n').entries.get('k').type, 'symbol')
  })

  it('refuses what Psych would read otherwise or refuse', () => {
    for (const [text, pattern] of [
      ['---\nk: v # c\n', /in a plain scalar, which Psych would read otherwise$/u],
      ['---\n# c\nk: v\n', /a comment, which Psych does not write$/u],
      ['---\nk: !ruby/object:Foo\n  a: b\n', /the tag "!ruby\/object:Foo", of a class RubyGems does not permit$/u],
      ['---\nk: :foo\n', /the symbol ":foo", which RubyGems does not permit$/u],
      ['---\n<<: *a\n', /a merge key|an alias to no anchor/u],
      ['---\nk: [a]\n', /is no scalar as Psych writes one$/u],
      ['---\nk: v\nk: w\n', /a second "k"$/u],
      ['---\nk: "a\u2028b"\n', /a line break of YAML 1\.1 but LF/u],
      ['---\nk: "a\\qb"\n', /an escape YAML does not have$/u],
      ['---\nk: "open\n', /a quoted scalar with no closing quote$/u],
      ['%YAML 1.1\n---\nk: v\n', /no `---` first/u],
      ['---\nk: v\n--- \nl: w\n', /in a plain scalar|more after the document|expected a mapping key/u],
      [`---\n${'- '.repeat(70)}x\n`, /nested past 64 levels$/u],
    ]) assert.throws(() => read(text), (error) => error instanceof DeptreeError && pattern.test(error.message), text)
  })
})

describe('buildBundlerTree\'s options', () => {
  it('takes the host, the files and the Vfs it is given, and nothing else', async () => {
    const leaf = await gemOf({ name: 'leaf', version: '1.0.0' })
    const host = (fields) => build([leaf], { host: { ...HOST, ...fields } }, { bundled: null })
    for (const bundler of ['2.5.11', '2.4.22', '3.0.0', '4.1.0', '2.6', '4.0.0.beta1']) await assert.rejects(host({ bundler }), /^DeptreeError: host\.bundler: Bundler ".*" is not supported: only 2\.5\.12 to 2\.7\.x and 4\.0\.x are$/u, bundler)
    for (const rubygems of ['3.4.22', '3.5.14', '4.1.0', '3.5']) await assert.rejects(host({ rubygems }), /^DeptreeError: host\.rubygems: RubyGems ".*" is not supported: only 3\.5\.15 to 4\.0\.x are$/u, rubygems)
    for (const ruby of ['2.7.8', '3.4.0.dev', '4.1.0', '3.3']) await assert.rejects(host({ ruby }), /^DeptreeError: host\.ruby: Ruby ".*" is not supported/u, ruby)
    await assert.rejects(host({ os: 'win32', platform: 'x64-mingw-ucrt' }), /^DeptreeError: host\.os: Windows is not supported/u)
    await assert.rejects(host({ os: 'freebsd' }), /^DeptreeError: host\.os: "freebsd" is not supported: only macOS and Linux are$/u)
    await assert.rejects(host({ platform: 'universal-java-17' }), /^DeptreeError: host\.platform: "universal-java-17" is no platform of linux/u)
    await assert.rejects(host({ platform: 'x86_64-linux-' }), /^DeptreeError: host\.platform: "x86_64-linux-" is no platform as Gem::Platform\.local writes one$/u)
    await assert.rejects(host({ platform: 'arm64-darwin-23' }), /is no platform of linux/u)
    assert.equal((await host({ ruby: '3.4.1', rubygems: '3.6.2', bundler: '2.6.2', platform: 'arm64-darwin-24', os: 'darwin' })).installed[0].path, 'vendor/bundle/ruby/3.4.0/gems/leaf-1.0.0')
    await assert.rejects(buildBundlerTree({ host: HOST }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: 1, host: HOST }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: lockOf([leaf]), host: HOST, project: createVfs({}) }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: lockOf([leaf]), host: HOST, partial: 'yes' }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: lockOf([leaf]), host: HOST, vfs: {} }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: lockOf([leaf]), host: { ...HOST, ruby: undefined } }), TypeError)
    await assert.rejects(buildBundlerTree({ lockfile: 'GEM\n', host: HOST }), LockfileError)
  })

  it('fetches sixteen .gem files at a time, and refuses once every fetch started has ended', async () => {
    const gems = await Promise.all(Array.from({ length: 20 }, (_, i) => gemOf({ name: `g${String.fromCodePoint(97 + i)}`, version: '1.0.0' })))
    stubGems(gems)
    const count = gathered(16)
    assert.equal((await buildBundlerTree({ lockfile: lockOf(gems), host: HOST })).stats.installed, 20)
    assert.equal(count.most, 16)
    stubGems(gems)
    const open = slowed(20, (input) => (input.includes('/ga-') ? new Response('no', { status: 404 }) : undefined))
    await assert.rejects(buildBundlerTree({ lockfile: lockOf(gems), host: HOST }), /^DeptreeError: specs\["ga-1\.0\.0"\]: /u)
    assert.equal(open.open, 0)
  })
})
