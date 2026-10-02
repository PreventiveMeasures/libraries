import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseGemfileLock } from '../../bundler.js'
import { FIXTURES } from './fixtures.js'

// Real lockfiles, as Bundler writes them: one project with every kind of
// source Bundler locks, by Bundler 2.2, 2.4, 2.5, 2.6, 2.7 and 4.0; one of
// a directory alone; and the project locked by 2.7, then by 4.0.
// scripts/record-bundler.js records them into fixtures.json.br; its header
// says how.

const text = (name) => FIXTURES[name]
const read = (name) => parseGemfileLock(text(name))
const plain = (value) => JSON.parse(JSON.stringify(value))

const RACK_TEST = { type: 'git', remote: 'https://github.com/rack/rack-test.git', revision: '81a2ea15e107785d3692b81d7fa2bef969acc88f', tag: 'v2.1.0', submodules: false }
const TSORT = { type: 'git', remote: 'https://github.com/ruby/tsort.git', revision: '90166c8135b0cf96667291aaadb20c0c453656a3', branch: 'master', submodules: true }
const SINATRA = '7b50a1bbb5324838908dfaa00ec53ad322673a29'

describe('Bundler 4.0', () => {
  const lock = read('bundler-4.0.22')

  it('every kind of source, git and path first', () => {
    assert.deepEqual(plain(lock.sources), [
      RACK_TEST,
      TSORT,
      { type: 'git', remote: 'https://github.com/sinatra/sinatra.git', revision: SINATRA, ref: SINATRA, submodules: false, glob: '{,*/}*.gemspec' },
      { type: 'path', path: '.' },
      { type: 'path', path: 'vendor/localgem', glob: '*.gemspec' },
      { type: 'gem', remote: 'https://gem.coop/' },
      { type: 'gem', remote: 'https://rubygems.org/' },
    ])
  })

  it('a gem for each platform, and their own dependencies', () => {
    assert.deepEqual(lock.gems.nokogiri, ['nokogiri-1.16.7', 'nokogiri-1.16.7-aarch64-linux', 'nokogiri-1.16.7-arm-linux', 'nokogiri-1.16.7-arm64-darwin', 'nokogiri-1.16.7-x86-linux', 'nokogiri-1.16.7-x86_64-darwin', 'nokogiri-1.16.7-x86_64-linux'])
    assert.deepEqual(plain(lock.specs['nokogiri-1.16.7'].dependencies), { mini_portile2: ['~> 2.8.2'], racc: ['~> 1.4'] })
    assert.deepEqual(plain(lock.specs['nokogiri-1.16.7-x86_64-linux']), {
      name: 'nokogiri',
      version: '1.16.7',
      platform: 'x86_64-linux',
      source: 6,
      dependencies: { racc: ['~> 1.4'] },
      checksum: 'sha256=9e1e428641d5942af877c60b418c71163560e9feb4a5c4015f3230a8b86a40f6',
    })
    assert.deepEqual(lock.platforms, ['aarch64-linux', 'arm-linux', 'arm64-darwin', 'ruby', 'x86-linux', 'x86_64-darwin', 'x86_64-linux'])
  })

  it('what the Gemfile asks for, pinned to a source, and for a platform not locked', () => {
    assert.deepEqual(plain(lock.dependencies.rack), { requirements: ['>= 2.2', '< 4', '!= 3.0.0'], pinned: false })
    assert.deepEqual(plain(lock.dependencies.rainbow), { requirements: ['= 3.1.1'], pinned: true })
    assert.deepEqual(plain(lock.dependencies.myapp), { requirements: [], pinned: true })
    assert.equal(lock.specs[lock.gems.rainbow[0]].source, 5)
    assert.deepEqual(plain(lock.dependencies['tzinfo-data']), { requirements: [], pinned: false })
    assert.equal(lock.gems['tzinfo-data'], undefined)
  })

  it('a git source of two gems, one the other depends on', () => {
    assert.deepEqual(lock.gems.sinatra.concat(lock.gems['rack-protection']).map((key) => lock.specs[key].source), [2, 2])
    assert.deepEqual(lock.specs['sinatra-4.1.1'].dependencies['rack-protection'], ['= 4.1.1'])
  })

  it('checksums of the gems from a server, Bundler\'s own among them, and the Ruby without its patchlevel', () => {
    assert.equal(lock.checksums, true)
    assert.equal(lock.specs['sinatra-4.1.1'].checksum, undefined)
    assert.equal(lock.specs['myapp-0.1.0'].checksum, undefined)
    assert.ok(Object.values(lock.specs).every((spec) => (lock.sources[spec.source].type === 'gem') === (spec.checksum !== undefined)))
    assert.deepEqual(plain(lock.bundlerChecksum), { version: '4.0.22', checksum: 'sha256=d8d5ec84c8555e0af71db63ed7aee4d1a8fb839ec46d84212d61979242a5d75a' })
    assert.deepEqual([lock.rubyVersion, lock.bundledWith], ['ruby 3.3.6', '4.0.22'])
  })
})

describe('Bundler 2', () => {
  it('the same gems, at the same versions, by every version', () => {
    const names = (name) => [...new Set(Object.values(read(name).specs).map((spec) => `${spec.name} ${spec.version}`))].sort()
    for (const version of ['2.2.34', '2.4.22', '2.5.23']) assert.deepEqual(names(`bundler-${version}`), names('bundler-4.0.22'), version)
    // 2.6 and 2.7, asked to add checksums, leave out nokogiri's gem of no
    // platform, and mini_portile2 with it, though PLATFORMS has ruby.
    for (const version of ['2.6.9', '2.7.2']) assert.deepEqual(names(`bundler-${version}`), names('bundler-4.0.22').filter((name) => !name.startsWith('mini_portile2 ')), version)
    const lock = read('bundler-2.7.2')
    assert.ok(lock.platforms.includes('ruby') && !lock.gems.nokogiri.includes('nokogiri-1.16.7'))
  })

  it('the platforms asked for alone, before 2.5, and the Ruby with its patchlevel, three spaces in', () => {
    const lock = read('bundler-2.4.22')
    assert.deepEqual(lock.platforms, ['arm64-darwin', 'ruby', 'x86_64-linux'])
    assert.deepEqual(lock.gems.nokogiri, ['nokogiri-1.16.7', 'nokogiri-1.16.7-arm64-darwin', 'nokogiri-1.16.7-x86_64-linux'])
    assert.deepEqual([lock.rubyVersion, lock.bundledWith], ['ruby 3.3.6p108', '2.4.22'])
    assert.ok(text('bundler-2.4.22').endsWith('\nBUNDLED WITH\n   2.4.22\n'))
  })

  it('CHECKSUMS from 2.6, where asked, without Bundler\'s own', () => {
    assert.deepEqual(['2.2.34', '2.4.22', '2.5.23', '2.6.9', '2.7.2'].map((version) => read(`bundler-${version}`).checksums), [false, false, false, true, true])
    const lock = read('bundler-2.7.2')
    assert.equal(lock.bundlerChecksum, undefined)
    assert.equal(lock.specs['rainbow-3.1.1'].checksum, 'sha256=039491aa3a89f42efa1d6dec2fc4e62ede96eb6acd95e52f1ad581182b79bc6a')
  })
})

describe('Bundler 4.0, otherwise', () => {
  it('a directory alone, and a GEM source of no remote and no gems', () => {
    const lock = read('bundler-4.0.22-path')
    assert.deepEqual(plain(lock.sources), [{ type: 'path', path: 'plain' }, { type: 'gem' }])
    assert.deepEqual(Object.keys(lock.specs), ['plain-0.1.0'])
    assert.equal(lock.rubyVersion, undefined)
  })

  it('a lockfile of 2.7 locked again: its Ruby kept, two spaces in, and no CHECKSUMS added', () => {
    const lock = read('bundler-4.0.22-upgrade')
    assert.deepEqual([lock.rubyVersion, lock.bundledWith, lock.checksums], ['ruby 3.3.6p108', '4.0.22', false])
    assert.ok(text('bundler-4.0.22-upgrade').endsWith('\nRUBY VERSION\n  ruby 3.3.6p108\n\nBUNDLED WITH\n  4.0.22\n'))
  })
})
