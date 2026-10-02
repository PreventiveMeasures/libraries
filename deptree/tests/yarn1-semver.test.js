import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { satisfiesWithPrereleases } from '../src/yarn1/peers.js'

// yarn checks peers and its own engines.yarn with this, read off semver's
// normalized range: every comparator tested on its own, prereleases and
// all, a `<` with none of its own below its lowest.
describe('satisfiesWithPrereleases', () => {
  it('takes a prerelease where every comparator does, but not below a bare upper bound', () => {
    assert.equal(satisfiesWithPrereleases('1.5.0-beta', '^1.0.0'), true)
    assert.equal(satisfiesWithPrereleases('2.0.0-rc.1', '<2.0.0'), false)
    assert.equal(satisfiesWithPrereleases('2.0.0-rc.0', '<2.0.0-rc.1'), true)
    assert.equal(satisfiesWithPrereleases('1.2.3', '1.2.3 || >=3'), true)
    assert.equal(satisfiesWithPrereleases('3.0.0-alpha', '1.2.3 || >=3'), false)
    assert.equal(satisfiesWithPrereleases('9.9.9', '*'), true)
  })

  it('takes nothing for what is not a range or a version, and reads loosely where asked', () => {
    assert.equal(satisfiesWithPrereleases('1.0.0', 'latest'), false)
    assert.equal(satisfiesWithPrereleases('', '*'), false)
    assert.equal(satisfiesWithPrereleases('=1.2.3', '^1.0.0'), false)
    assert.equal(satisfiesWithPrereleases('=1.2.3', '^1.0.0', true), true)
  })
})
