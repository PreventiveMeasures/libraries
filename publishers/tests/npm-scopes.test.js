import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import scopes from '../npm-scopes.js'

describe('npm-scopes.js', () => {
  it('exports its list alone', async () => {
    assert.deepEqual(Object.keys(await import('../npm-scopes.js')), ['default'])
  })

  it('lists scopes, with their @, each once', () => {
    assert.ok(scopes.length > 200)
    for (const scope of scopes) assert.match(scope, /^@[a-z0-9~-][\w.~-]*$/u)
    assert.equal(new Set(scopes).size, scopes.length)
  })

  it('lists the scopes of npm\'s most downloaded packages, the most downloads first', () => {
    assert.deepEqual(scopes.slice(0, 2), ['@babel', '@types'])
    assert.ok(scopes.includes('@aws-sdk'))
    assert.ok(!scopes.includes('@preventive'))
  })
})
