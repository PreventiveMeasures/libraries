import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { LockfileError } from '../../cargo.js'
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

  it('refuses a target name that is empty or not ASCII, which the crate takes', () => {
    assert.equal(oracle.platforms[''], false)
    assert.equal(parsePlatform(''), undefined)
    assert.equal(parsePlatform('ünix'), undefined)
  })

  it('throws a TypeError for anything but a string', () => {
    assert.throws(() => parsePlatform(1), TypeError)
    assert.throws(() => parseCfg(undefined), TypeError)
  })
})
