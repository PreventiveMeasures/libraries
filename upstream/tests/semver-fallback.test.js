import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// A process whose binary is not node, which is where the lookup gives up
// before touching the filesystem: the same outcome as a Node install with
// no npm beside it. Set before the first call, since the answer is kept
// for the rest of the process — which is also why this is a file of its
// own.
process.argv[0] = '/nowhere/not-node'

const { compareVersions, isExactVersion, satisfies, semverAvailable, valid } = await import('../semver.js')

describe('without npm beside node', () => {
  it('says so', () => {
    assert.equal(semverAvailable(), false)
  })

  it('throws rather than guessing', () => {
    assert.throws(() => satisfies('1.0.0', '^1'), /no npm beside node/u)
    assert.throws(() => compareVersions('1.0.0', '1.0.1'), /no npm beside node/u)
    assert.throws(() => valid('1.2.3-rc.1'), /no npm beside node/u)
    assert.throws(() => valid('v1.2.3'), /no npm beside node/u)
    assert.throws(() => valid('1.2.3', { loose: true }), /no npm beside node/u)
  })

  it('still answers a plain release, which needs no semver', () => {
    assert.equal(valid('1.2.3'), '1.2.3')
    assert.equal(isExactVersion('10.0.0'), true)
    assert.equal(isExactVersion(42), false)
  })
})
