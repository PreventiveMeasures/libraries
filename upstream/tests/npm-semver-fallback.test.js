import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// A process whose binary is not node, which is where the lookup gives up
// before touching the filesystem: the same outcome as a Node install
// with no npm beside it. Set before the first call, since the answer is
// kept for the rest of the process — which is also why this is a file
// of its own.
process.argv[0] = '/nowhere/not-node'

const { compareVersions, satisfies, semverAvailable } = await import('../npm.js')

describe('without npm beside node', () => {
  it('says so', () => {
    assert.equal(semverAvailable(), false)
  })

  it('reads every range as matching, never hiding one', () => {
    assert.equal(satisfies('4.17.21', '<4.17.21'), true)
    assert.equal(satisfies('9.9.9', '1.0.0'), true)
  })

  it('orders versions as strings, deterministically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), -1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  })
})
