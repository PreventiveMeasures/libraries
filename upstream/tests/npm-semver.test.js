import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareVersions, isExactVersion, satisfies, semverAvailable } from '../npm.js'

// Against the npm that ships beside the node running this, which every
// install these tests run on has.

describe("npm's semver, borrowed", () => {
  it('is found beside node', () => {
    assert.equal(semverAvailable(), true)
  })

  it('matches a range', () => {
    assert.equal(satisfies('4.17.20', '<4.17.21'), true)
    assert.equal(satisfies('4.17.21', '<4.17.21'), false)
    assert.equal(satisfies('1.2.3', '>=1.0.0 <2.0.0 || >=3.0.0'), true)
    assert.equal(satisfies('2.5.0', '>=1.0.0 <2.0.0 || >=3.0.0'), false)
  })

  it('counts a prerelease of a covered version as covered', () => {
    // Plain semver would say no: `<4.17.21` names no prerelease.
    assert.equal(satisfies('4.17.20-rc.1', '<4.17.21'), true)
  })

  it('reads a range it cannot parse as matching everything', () => {
    assert.equal(satisfies('1.0.0', 'not a range'), true)
    assert.equal(satisfies('1.0.0', '>=<1'), true)
  })

  it('orders versions as versions', () => {
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
    assert.deepEqual(['1.10.0', '1.2.0', '1.9.0'].toSorted(compareVersions), ['1.2.0', '1.9.0', '1.10.0'])
  })

  it('orders what is not a version as a string', () => {
    assert.equal(compareVersions('file:a', 'file:b'), -1)
    assert.equal(compareVersions('link:b', 'link:a'), 1)
  })
})

describe('isExactVersion', () => {
  it('takes a resolved version', () => {
    for (const version of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3+build.5', '1.2.3-beta.2+sha.abc']) {
      assert.equal(isExactVersion(version), true, version)
    }
  })

  it('refuses a range, a pin or a non-string', () => {
    for (const version of ['^1.2.3', '1.2', '1.2.x', 'file:../a', 'link:a', 'latest', '', 123, undefined, null]) {
      assert.equal(isExactVersion(version), false, String(version))
    }
  })
})
