import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseGemfileLock } from '../../bundler.js'
import { isPlatform, platformOf } from '../../src/rubygems/gem.js'
import { compareVersions, isVersion, parseRequirement, satisfies } from '../../src/rubygems/version.js'
import { random } from '../random.js'
import { FIXTURES } from './fixtures.js'
import { hasBundler, ruby, versions } from './reference.js'

// RubyGems and Bundler, from the ruby on PATH, against the readers here.
// Versions, requirements and platforms made at random from pieces, now and
// then with a character put in or taken out: two versions are ordered
// alike, a requirement is met alike, and a platform is written back alike,
// by the RubyGems, 3 or 4, that runs.
// Then the fixtures, each with edits made at random: every lockfile read
// here Bundler's LockfileParser reads, to the same sources, gems,
// dependencies, platforms, checksums and versions. The seeds are fixed.

const skip = !hasBundler() && 'no ruby with Bundler 2.5 or later'

function flaw(text, { next, pick }) {
  if (next() < 0.6) return text
  const at = Math.floor(next() * (text.length + 1))
  const cut = next() < 0.5
  return `${text.slice(0, at)}${cut ? '' : pick(['.', '-', '_', ' ', '0', 'a', 'Z', '1'])}${text.slice(at + (cut ? 1 : 0))}`
}

const SEGMENTS = ['0', '1', '2', '9', '10', '01', '00', '007', '18446744073709551617', 'a', 'b', 'pre', 'rc1', 'A', 'beta2', 'z', '0a', 'a0', 'dev']

function version({ next, pick }) {
  const head = pick(['0', '1', '2', '10', '01', '1'])
  const rest = Array.from({ length: Math.floor(next() * 4) }, () => pick(SEGMENTS))
  return [head, ...rest].join('.')
}

describe('RubyGems versions and requirements', { skip }, () => {
  it('a version as Bundler writes one is one RubyGems reads', () => {
    const generator = random(0x6E_51_0A)
    const texts = Array.from({ length: 3000 }, () => flaw(version(generator), generator)).filter((text) => text !== '' && !/[\s-]/u.test(text))
    const results = ruby(texts.map((text) => ['correct', text]))
    let both = 0
    for (const [index, text] of texts.entries()) {
      assert.equal(isVersion(text), results[index].value, JSON.stringify(text))
      if (isVersion(text)) both++
    }
    assert.ok(both > 1000, `only ${both} versions read`)
  })

  it('two versions are ordered alike', () => {
    const generator = random(0x0D_E2)
    const pairs = Array.from({ length: 4000 }, () => {
      const a = version(generator)
      return [a, generator.next() < 0.3 ? `${a}${generator.pick(['', '.0', '.0.0', '.a', '.1'])}` : version(generator)]
    })
    const results = ruby(pairs.map((pair) => ['compare', pair]))
    for (const [index, [a, b]] of pairs.entries()) assert.equal(compareVersions(a, b), results[index].value, JSON.stringify([a, b]))
  })

  it('a requirement is met alike', () => {
    const generator = random(0x5A_71)
    const OPS = ['=', '!=', '>', '<', '>=', '<=', '~>']
    const cases = Array.from({ length: 4000 }, () => [`${generator.pick(OPS)} ${version(generator)}`, version(generator)])
    const results = ruby(cases.map((pair) => ['satisfies', pair]))
    for (const [index, [requirement, against]] of cases.entries()) {
      assert.equal(satisfies(against, parseRequirement(requirement)), results[index].value, JSON.stringify([requirement, against]))
    }
  })
})

const CPUS = ['x86_64', 'x86', 'i686', 'i386', 'arm64', 'aarch64', 'universal', 'arm', 'armv7l', 'x64', 'powerpc', 'sparc', 'java', 'mswin32', 'mswin64', 'jruby', 'ruby']
const OSES = [
  'linux', 'linux-gnu', 'linux-musl', 'linux-gnueabihf', 'linux_musl', 'darwin', 'darwin19', 'darwin-23', 'mingw32', 'mingw', 'mingw-ucrt',
  'java', 'java1.8', 'javax', 'jruby', 'dalvik', 'dalvik2', 'dotnet', 'dotnet4.0', 'freebsd', 'freebsd13', 'openbsd7.2', 'solaris2.11',
  'aix7', 'cygwin', 'wasi', 'netbsdelf', 'macruby', 'foo_platform2', 'unknown', 'linuxx', 'xlinux', 'mswin32_140', 'mswin64', '',
]
const VERSIONS = ['', '', '-1', '-23', '-1.8', '-gnu', '-musl', '-eabihf', '-x', '-1-2', '-']

describe('RubyGems platforms', { skip }, () => {
  it('a platform is written back alike', () => {
    const rubygems = Number(versions()[0].split('.')[0]) >= 4 ? 4 : 3
    const generator = random(0x91_A7)
    const { next, pick } = generator
    const texts = [...new Set(Array.from({ length: 4000 }, () => {
      const parts = next() < 0.15 ? [pick(OSES)] : [pick(CPUS), pick(OSES)]
      return flaw(`${parts.filter((part) => part !== '').join('-')}${pick(VERSIONS)}`, generator)
    }))].filter((text) => /^[\w.-]+$/u.test(text) && text !== 'ruby' && text !== 'current')
    const results = ruby(texts.map((text) => ['platform', text]))
    let fixed = 0
    for (const [index, text] of texts.entries()) {
      assert.equal(platformOf(text, rubygems), results[index].value, JSON.stringify(text))
      if (isPlatform(text)) fixed++
    }
    assert.ok(fixed > 300, `only ${fixed} platforms written back as read`)
  })
})

const bundlerChecksum = ({ bundlerChecksum: own }) => (own === undefined ? {} : { [`bundler (${own.version})`]: [own.checksum] })

// What Bundler's parser reads a lockfile to, made from what is read here;
// with Bundler 2, no checksum of its own.
function expected(lock, own = true) {
  const source = (item) => {
    if (item.type === 'path') return { type: 'path', path: item.path, glob: item.glob ?? null }
    if (item.type === 'gem') return { type: 'gem', remotes: item.remote === undefined ? [] : [item.remote] }
    const options = { revision: item.revision, ref: item.ref, branch: item.branch, tag: item.tag, submodules: item.submodules || undefined, glob: item.glob }
    return { type: 'git', remote: item.remote, options: JSON.parse(JSON.stringify(options)) }
  }
  const requirement = (list) => (list.length === 0 ? ['>= 0'] : list)
  const specs = Object.entries(lock.specs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, spec]) => ({
    key, name: spec.name, version: spec.version, platform: spec.platform, source: spec.source,
    dependencies: Object.entries(spec.dependencies).map(([name, list]) => [name, requirement(list)]),
    checksum: spec.checksum ?? null,
  }))
  const pinnedTo = (name, pinned) => (pinned && name !== 'bundler' && name in lock.gems ? lock.specs[lock.gems[name][0]].source : null)
  return {
    sources: lock.sources.map(source),
    specs,
    dependencies: Object.entries(lock.dependencies).map(([name, { requirements, pinned }]) => [name, requirement(requirements), pinnedTo(name, pinned)]),
    platforms: lock.platforms,
    checksums: lock.checksums,
    metadata: own ? bundlerChecksum(lock) : null,
    ruby: lock.rubyVersion ?? null,
    bundler: lock.bundledWith ?? null,
  }
}

const TEXTS = Object.values(FIXTURES)

// Pieces of what Bundler writes, and of what it does not, for one to
// stand in for another.
const SWAPS = [
  [' (', '('], [' (', '  ('], [')', ') '], ['!', ''], ['\n', '!\n'], [', ', ','], [', ', ' , '], ['~> ', '~>'], ['~>', '>='], ['>=', '='], ['= ', '!= '],
  ['1', '2'], ['1', '01'], ['.', '.0.'], ['.', '-'], ['3', '3.a'], ['(', '(1.0-'], ['-x86_64-linux', '-x86_64-linux-gnu'], ['-arm64-darwin', '-ruby'],
  ['-arm64-darwin', '-universal-darwin'], ['-x86_64-linux', ''], ['rack', 'Rack'], ['rack', '_rack'], ['rack', 'bundler'], ['sha256=', 'sha512='],
  ['sha256=', 'sha256=A'], ['https://rubygems.org/', 'https://rubygems.org'], ['https://rubygems.org/', 'file:///srv/gems/'], ['https://gem.coop/', 'file://localhost/srv/gems/'], ['https://', 'http://'], ['remote: ', 'remote:  '], ['.git\n', '.git/\n'],
  ['tag: ', 'branch: '], ['branch: ', 'ref: '], ['submodules: true', 'submodules: false'], ['glob: ', 'glob:  '], ['revision: ', 'ref: '],
  ['remote: .', 'remote: ./.'], ['remote: vendor', 'remote: /vendor'], ['ruby 3', 'ruby  3'], ['p108', ''], ['p108', 'p-1'], ['ruby 3.3.6', 'ruby 3.3.6 (jruby 9.4.5.0)'],
  ['  ruby\n', '  java\n'], ['  ruby\n', '  ruby\n  x86_64-linux\n'], ['DEPENDENCIES\n', 'DEPENDENCIES\n  bundler (>= 2)\n'], ['\n  4.', '\n   4.'], ['\n   2.', '\n  2.'],
  ['    ', '   '], ['      ', '     '], ['  specs:', '  specs: '], ['GEM\n', 'GEM\n  remote: https://gem.coop/\n'], ['\n\n', '\n'], ['\n\n', '\n\n\n'],
]

// Where `from` is in `text`, each place.
function spots(text, from) {
  const found = []
  for (let at = text.indexOf(from); at !== -1; at = text.indexOf(from, at + 1)) found.push(at)
  return found
}

// A line taken out, written twice, swapped with the next or indented one
// more, or a piece of one for another.
function edit(text, { next, pick }) {
  const roll = next()
  if (roll < 0.4) {
    const lines = text.split('\n')
    const at = Math.floor(next() * (lines.length - 1))
    if (roll < 0.15) lines.splice(at, 1)
    else if (roll < 0.25) lines.splice(at, 0, lines[at])
    else if (roll < 0.35) lines.splice(at, 2, lines[at + 1], lines[at])
    else lines[at] = ` ${lines[at]}`
    return lines.join('\n')
  }
  const [from, to] = pick(SWAPS)
  const found = spots(text, from)
  if (found.length === 0) return text
  const at = pick(found)
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`
}

const accepts = (text) => {
  try {
    return parseGemfileLock(text)
  } catch (error) {
    assert.equal(error.name, 'LockfileError', error.stack)
    return undefined
  }
}

describe('lockfiles against Bundler', { skip }, () => {
  const own = !skip && Number(versions()[1].split('.')[0]) >= 4

  it('reads each fixture as Bundler does', () => {
    const results = ruby(TEXTS.map((text) => ['lockfile', text]))
    for (const [index, text] of TEXTS.entries()) assert.deepEqual(results[index].value, expected(parseGemfileLock(text), own))
  })

  it('reads every edited fixture it takes as Bundler does', () => {
    const rand = random(0x6E_44_1C)
    const docs = new Set()
    for (let i = 0; i < 4000; i++) {
      let text = rand.pick(TEXTS)
      for (let edits = 1 + Math.floor(rand.next() * 2); edits > 0; edits--) text = edit(text, rand)
      if (rand.next() < 0.05) text = text.replaceAll('\n', '\r\n')
      docs.add(text)
    }
    const read = [...docs].map((text) => [text, accepts(text)]).filter(([, lock]) => lock !== undefined)
    const results = ruby(read.map(([text]) => ['lockfile', text]))
    for (const [index, [text, lock]] of read.entries()) assert.deepEqual(results[index], { value: expected(lock, own) }, text)
    assert.ok(read.length > 200 && read.length < docs.size / 2, `${read.length} of ${docs.size} read`)
  })
})
