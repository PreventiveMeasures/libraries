import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError, matchCargoPlatform } from '../../cargo.js'
import { matches, parseVersion } from '../../rust-semver.js'
import { parseRequirement } from '../../src/cargo/dependency.js'
import { parseCfg, parsePlatform, platformMatches } from '../../src/crate/cargo-platform.js'

// Version requirements and platforms, against what the semver and
// cargo-platform crates cargo reads them with make of each, from
// scripts/record-cargo.js: null where the crate refuses one. Requirements
// are read by the semver port rust-semver.js shares, as cargo writes them.

const oracle = JSON.parse(readFileSync(new URL('fixtures/oracle.json', import.meta.url), 'utf8'))

describe('version requirements, as the semver crate reads them', () => {
  const versions = oracle.versions.map(parseVersion)
  for (const [text, expected] of Object.entries(oracle.requirements)) {
    it(JSON.stringify(text), () => {
      if (expected === null) {
        assert.throws(() => parseRequirement(text, 'here'), LockfileError)
        return
      }
      const requirement = parseRequirement(text, 'here')
      assert.deepEqual(versions.map((version) => matches(requirement, version)), expected)
    })
  }

  it('reads a number up to 2^64 - 1, as the crate does', () => {
    assert.equal(parseRequirement('18446744073709551615', 'here')[0].major, 18446744073709551615n)
    assert.throws(() => parseRequirement('18446744073709551616', 'here'), LockfileError)
  })

  it('says where a requirement is', () => {
    assert.throws(() => parseRequirement('>=1 <2', 'dependencies.a.version'), {
      message: 'dependencies.a.version: ">=1 <2" is not a version requirement',
    })
  })
})

describe('platforms, as the cargo-platform crate reads them', () => {
  const host = { name: oracle.host.name, cfg: new Set(oracle.host.cfg.map((line) => parseCfg(line))) }
  // An empty target name, which the crate takes and nothing matches, is
  // refused, below.
  for (const [text, expected] of Object.entries(oracle.platforms).filter(([platform]) => platform !== '')) {
    it(JSON.stringify(text), () => {
      if (expected === null) assert.equal(parsePlatform(text), undefined)
      else assert.equal(platformMatches(parsePlatform(text), host), expected)
    })
  }

  // Known in part, as a build that knows only what its target is but not
  // what rustflags add, or nothing of the host: what is decided, the crate
  // decides the same.
  it('matches as the crate does, and where the platform is known in part, decides only as it does', () => {
    const decided = ['unix', 'windows', 'target_os', 'target_arch']
    const views = [
      { name: oracle.host.name, cfg: oracle.host.cfg },
      { name: oracle.host.name, cfg: oracle.host.cfg.filter((line) => decided.includes(line.split('=')[0])), decides: decided },
      { name: oracle.host.name, cfg: [], decides: [] },
      { name: undefined, cfg: [], decides: [] },
    ]
    const read = Object.entries(oracle.platforms).filter(([text, expected]) => text !== '' && expected !== null)
    const answers = views.map((view) => read.map(([text, expected]) => {
      const answer = matchCargoPlatform(view)(text)
      assert.ok(answer === expected || (answer === undefined && view.decides !== undefined), `${text}: ${answer}, where the crate says ${expected}`)
      return answer
    }))
    // Of the 15, all(), any(), true and false need no cfg, and the 3 names
    // need the name alone.
    assert.deepEqual(answers.map((list) => list.filter((answer) => answer === undefined).length), [0, 0, 8, 11])
  })

  it('refuses a target name that is empty or not ASCII, which the crate takes', () => {
    assert.equal(oracle.platforms[''], false)
    assert.equal(parsePlatform(''), undefined)
    assert.equal(parsePlatform('ünix'), undefined)
  })

  it('refuses a cfg nested more than 64 deep, which would run out of stack, in time linear in its length', () => {
    const nested = (depth) => `cfg(${'not('.repeat(depth)}unix${')'.repeat(depth)})`
    assert.equal(platformMatches(parsePlatform(nested(64)), { name: 'x', cfg: new Set(['unix']) }), true)
    assert.equal(parsePlatform(nested(65)), undefined)
    assert.equal(parsePlatform(`cfg(${'all('.repeat(65)}${')'.repeat(65)})`), undefined)
    assert.equal(parsePlatform(nested(100_000)), undefined)
  })

  it('throws a TypeError for anything but a string', () => {
    assert.throws(() => parsePlatform(1), TypeError)
    assert.throws(() => parseCfg(undefined), TypeError)
  })
})
