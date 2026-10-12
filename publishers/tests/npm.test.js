import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import publishers from '../npm.js'

describe('npm.js', () => {
  it('exports its list alone', async () => {
    assert.deepEqual(Object.keys(await import('../npm.js')), ['default'])
  })

  it('lists account names, each once', () => {
    assert.ok(publishers.length > 1000)
    for (const name of publishers) assert.match(name, /^[\w.-]+$/u)
    assert.equal(new Set(publishers).size, publishers.length)
  })

  it('lists the accounts with standing on a package, not those that published some versions of it in passing', () => {
    assert.ok(publishers.includes('sindresorhus'))
    // event-stream's three versions in 2018, in 24 days
    assert.ok(!publishers.includes('right9ctrl'))
  })
})
