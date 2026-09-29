import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError } from '../../cargo.js'
import { parseCfg, parsePlatform, platformMatches } from '../../src/cargo/platform.js'
import { matches, parseRequirement, parseVersion } from '../../src/cargo/semver.js'

// Version requirements and platforms, against what the semver and
// cargo-platform crates cargo reads them with make of each, from
// scripts/record-cargo.js: null where the crate refuses one.

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

  it('refuses a number past 2^53, where the crate reads up to 2^64', () => {
    assert.throws(() => parseRequirement('9007199254740992', 'here'), /is past 2\^53/u)
  })

  it('says where a requirement is', () => {
    assert.throws(() => parseRequirement('>=1 <2', 'dependencies.a.version'), {
      message: 'dependencies.a.version: ">=1 <2" is not a version requirement: unexpected "<"',
    })
  })
})

describe('platforms, as the cargo-platform crate reads them', () => {
  const host = { name: oracle.host.name, cfg: new Set(oracle.host.cfg.map((line) => parseCfg(line))) }
  // An empty target name, which the crate takes and nothing matches, is
  // refused, below.
  for (const [text, expected] of Object.entries(oracle.platforms).filter(([platform]) => platform !== '')) {
    it(JSON.stringify(text), () => {
      if (expected === null) assert.throws(() => parsePlatform(text, 'here'), LockfileError)
      else assert.equal(platformMatches(parsePlatform(text, 'here'), host), expected)
    })
  }

  it('refuses a target name that is empty or not ASCII, which the crate takes', () => {
    assert.equal(oracle.platforms[''], false)
    assert.throws(() => parsePlatform('', 'here'), /is neither a target's name nor cfg/u)
    assert.throws(() => parsePlatform('ünix', 'here'), /is neither a target's name nor cfg/u)
  })
})
