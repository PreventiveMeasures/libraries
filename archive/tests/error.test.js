import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveError, located } from '../src/error.js'

// located() puts an offset on a refusal from a check that does not know
// where in the archive it runs, and on nothing else.

describe('located', () => {
  it('hands back what the check returns', () => {
    assert.equal(located(() => 42, 512), 42)
  })
  it('places a refusal that has no offset yet', () => {
    assert.throws(() => located(() => {
      throw new ArchiveError('a name is bad')
    }, 512), (error) => error instanceof ArchiveError && error.message === 'a name is bad at byte 512' && error.offset === 512)
  })
  it('leaves a refusal already placed as it was', () => {
    const placed = new ArchiveError('a name is bad', 7)
    assert.throws(() => located(() => {
      throw placed
    }, 512), (error) => error === placed)
  })
  it('lets anything but a refusal through as itself, rather than as bad input', () => {
    const bug = new TypeError('x is not a function')
    assert.throws(() => located(() => {
      throw bug
    }, 512), (error) => error === bug)
  })
})
