import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseComposerLock } from '../../composer.js'

// Real lockfiles, as Composer writes them, each beside the composer.json it
// was written for: one project with every kind of package a lockfile
// records, locked by Composer 2.10, 2.8, 2.7, 2.2 and 2.0; a project that
// asks for nothing, by 2.10 and 2.2; and one indented with tabs, which
// 2.10 keeps. scripts/record-composer.js records them; its header says
// how.

const FIXTURES = new URL('fixtures/', import.meta.url)
const text = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')
const read = (name, options) => parseComposerLock(text(`${name}.lock`), options)
const plain = (value) => JSON.parse(JSON.stringify(value))

const NAMES = readdirSync(FIXTURES).filter((name) => name.endsWith('.lock')).map((name) => name.slice(0, -'.lock'.length))

describe('every fixture', () => {
  it('has them all', () => assert.equal(NAMES.length, 8))

  for (const name of NAMES) {
    it(`${name}: read, and fresh for its composer.json`, () => {
      assert.equal(read(name).fresh, undefined)
      assert.equal(read(name, { composerJson: text(`${name}.json`) }).fresh, true)
    })
  }
})

describe('Composer 2.10', () => {
  const lock = read('composer-2.10.3', { composerJson: text('composer-2.10.3.json') })
  const { packages } = lock

  it('the settings it installs by', () => {
    assert.equal(lock.pluginApiVersion, '2.9.0')
    assert.match(lock.contentHash, /^[\da-f]{32}$/u)
    assert.equal(lock.minimumStability, 'stable')
    assert.deepEqual(plain(lock.stabilityFlags), { 'doctrine/cache': 'stable', 'fixture/vcs': 'dev', 'symfony/var-dumper': 'beta' })
    assert.deepEqual([lock.preferStable, lock.preferLowest], [true, false])
    assert.deepEqual(plain(lock.platform), { php: '>=8.1', 'ext-json': '*' })
    assert.deepEqual(plain(lock.platformDev), { 'ext-mbstring': '*' })
    assert.deepEqual(plain(lock.platformOverrides), { php: '8.3.0' })
  })

  it('packages, then packages-dev, by name', () => {
    const names = Object.keys(packages)
    assert.equal(names.length, 21)
    assert.deepEqual(names.filter((name) => packages[name].dev), ['doctrine/cache', 'php-http/message-factory', 'symfony/var-dumper'])
    assert.ok(names.slice(0, 18).every((name) => !packages[name].dev))
  })

  it('a git repository at its default branch, under a branch alias and the root\'s', () => {
    const vcs = packages['fixture/vcs']
    assert.deepEqual([vcs.version, vcs.normalized, vcs.stability, vcs.defaultBranch], ['dev-main', 'dev-main', 'dev', true])
    assert.deepEqual(plain(vcs.source), { type: 'git', url: './repos/vcs', reference: vcs.source.reference, mirrors: [] })
    assert.match(vcs.source.reference, /^[\da-f]{40}$/u)
    assert.equal(vcs.dist, undefined)
    assert.deepEqual(vcs.aliases, [
      { version: '1.0.x-dev', normalized: '1.0.9999999.9999999-dev', root: false },
      { version: '1.1.0', normalized: '1.1.0.0', root: true },
    ])
    assert.deepEqual(plain(lock.aliases), [{ package: 'fixture/vcs', version: 'dev-main', alias: '1.1.0', aliasNormalized: '1.1.0.0' }])
    assert.equal(vcs.time, '2026-01-01T00:00:00+00:00')
  })

  it('a directory by a path repository, with a bin', () => {
    const local = packages['fixture/local']
    assert.deepEqual([local.dist.type, local.dist.url, local.dist.shasum], ['path', './packages/local', undefined])
    assert.deepEqual(local.bin, ['bin/local'])
    assert.deepEqual(plain(local.transportOptions), { relative: true })
    assert.deepEqual(plain(local.require), {
      php: { constraint: '>=8.1', platform: true, targets: [] },
      'psr/log': { constraint: '^3.0', platform: false, targets: ['psr/log'] },
    })
  })

  it('a package defined inline: a zip with a sha1, and a git tag', () => {
    const inline = packages['fixture/inline']
    assert.deepEqual(plain(inline.dist), { type: 'zip', url: 'https://example.com/inline-2.0.0.zip', shasum: '0123456789abcdef0123456789abcdef01234567', mirrors: [] })
    assert.deepEqual(plain(inline.source), { type: 'git', url: 'https://example.com/inline.git', reference: 'v2.0.0', mirrors: [] })
  })

  it('Packagist\'s, from GitHub with no sha1, and what Composer passes on', () => {
    const guzzle = packages['guzzlehttp/guzzle']
    assert.equal(guzzle.dist.type, 'zip')
    assert.match(guzzle.dist.url, /^https:\/\/api\.github\.com\/repos\/guzzle\/guzzle\/zipball\/[\da-f]{40}$/u)
    assert.equal(guzzle.dist.shasum, undefined)
    assert.equal(guzzle.notificationUrl, 'https://packagist.org/downloads/')
    assert.deepEqual(guzzle.license, ['MIT'])
    assert.ok(guzzle.keywords.includes('http client'))
    assert.ok(Array.isArray(guzzle.authors) && Array.isArray(guzzle.funding))
    assert.deepEqual(plain(guzzle.autoload), { files: ['src/functions_include.php'], 'psr-4': { 'GuzzleHttp\\': 'src/' } })
  })

  it('what meets a requirement: a provide, a replace at self.version, and the platform', () => {
    assert.deepEqual(packages['monolog/monolog'].provide['psr/log-implementation'], '3.0.0')
    assert.deepEqual(packages['ramsey/uuid'].replace['rhumsaa/uuid'], 'self.version')
    assert.deepEqual(packages['guzzlehttp/psr7'].require['psr/http-message'].targets, ['psr/http-message'])
    assert.deepEqual(plain(packages['symfony/var-dumper'].require['symfony/polyfill-mbstring']), { constraint: '~1.0', platform: false, targets: ['symfony/polyfill-mbstring'] })
    assert.deepEqual(packages['symfony/polyfill-mbstring'].provide['ext-mbstring'], '*')
  })

  it('conflicts, and abandoned packages', () => {
    assert.deepEqual(plain(packages['symfony/var-dumper'].conflict), { 'symfony/console': '<6.4' })
    assert.equal(packages['doctrine/cache'].abandoned, true)
    assert.equal(packages['php-http/message-factory'].abandoned, 'psr/http-factory')
    assert.equal(packages['guzzlehttp/guzzle'].abandoned, undefined)
  })
})

describe('every Composer 2 writes the project alike', () => {
  const packages = (name) => Object.values(read(name).packages).map((pkg) => `${pkg.name} ${pkg.version}`)

  for (const [name, api] of [['composer-2.8.12', '2.6.0'], ['composer-2.7.9', '2.6.0'], ['composer-2.2.30', '2.2.0'], ['composer-2.0.14', '2.0.0']]) {
    it(`${name}: plugin-api-version ${api}, and the same packages`, () => {
      assert.equal(read(name).pluginApiVersion, api)
      assert.deepEqual(packages(name), packages('composer-2.10.3'))
    })
  }

  it('stability-flags as the root asks, before 2.8, and sorted after', () => {
    assert.deepEqual(Object.keys(read('composer-2.7.9').stabilityFlags), ['fixture/vcs', 'doctrine/cache', 'symfony/var-dumper'])
    assert.deepEqual(Object.keys(read('composer-2.8.12').stabilityFlags), ['doctrine/cache', 'fixture/vcs', 'symfony/var-dumper'])
  })
})

describe('the empty project, and tabs', () => {
  it('nothing locked: `{}` of 2.10, `[]` of 2.2', () => {
    for (const name of ['composer-2.10.3-empty', 'composer-2.2.30-empty']) {
      const lock = read(name)
      assert.deepEqual([Object.keys(lock.packages), Object.keys(lock.stabilityFlags), Object.keys(lock.platform), lock.aliases], [[], [], [], []])
    }
    assert.match(text('composer-2.10.3-empty.lock'), /"platform": \{\},/u)
    assert.match(text('composer-2.2.30-empty.lock'), /"platform": \[\],/u)
  })

  it('a lockfile indented with tabs, as composer require rewrites it', () => {
    assert.match(text('composer-2.10.3-tabs.lock'), /^\{\n\t"_readme"/u)
    assert.deepEqual(Object.keys(read('composer-2.10.3-tabs').packages), ['psr/container'])
  })

  it('with CRLF throughout, as git may check one out', () => {
    const lock = parseComposerLock(text('composer-2.10.3.lock').replaceAll('\n', '\r\n'))
    assert.equal(Object.keys(lock.packages).length, 21)
  })
})
