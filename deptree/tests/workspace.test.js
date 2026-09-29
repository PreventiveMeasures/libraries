import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkWorkspace } from '../src/pnpm/workspace.js'

// pnpm 11 leaves out what a `!` glob takes with micromatch too, which
// takes a name starting with a dot where tinyglobby does not.
describe('checkWorkspace', () => {
  it('leaves out a directory under a dot directory by a `!` glob for pnpm 11 alone', () => {
    const ids = ['.', '.hidden/x']
    for (const packages of [['.hidden/*', '!**/x'], ['.hidden/*', '!*/x']]) {
      checkWorkspace(ids, packages, 10)
      assert.throws(() => checkWorkspace(ids, packages, 11), /^DeptreeError: importers\[".hidden\/x"\]: pnpm-workspace\.yaml's packages do not take this directory/u, packages.join(', '))
    }
    assert.throws(() => checkWorkspace(ids, ['**'], 11), /do not take this directory/u, 'a glob that takes it still spells the dot')
  })
})
