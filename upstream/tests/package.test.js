import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { getRepo } from '../package.js'

// getRepo over a package.json as it sits on disk, rather than the
// registry's document for one: the npm lookup's own tests cover the
// sources in depth, through getGitHub.

const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('getRepo', () => {
  it("reads this package's own package.json", () => {
    assert.deepEqual(getRepo(own), { github: 'PreventiveMeasures/libraries', directory: 'upstream', url: 'https://github.com/PreventiveMeasures/libraries' })
  })

  it('takes `bugs` as the URL itself, as a package.json may carry it', () => {
    assert.deepEqual(getRepo({ bugs: 'https://github.com/acme/app/issues' }), { github: 'acme/app', url: 'https://github.com/acme/app' })
    assert.deepEqual(getRepo({ bugs: 'bugs@acme.example' }), {})
  })

  it('answers the directory with the repo, never without it', () => {
    assert.deepEqual(getRepo({ repository: { type: 'git', url: 'git+https://github.com/babel/babel.git', directory: 'packages/babel-core' } }), { github: 'babel/babel', directory: 'packages/babel-core', url: 'https://github.com/babel/babel' })
    assert.deepEqual(getRepo({ repository: { url: 'https://gitlab.com/acme/app.git', directory: 'packages/x' } }), {})
  })

  it('answers nothing, rather than throwing, where nothing names a GitHub repo', () => {
    for (const pkg of [{}, { name: 'x' }, { homepage: 'https://example.com' }, { repository: 'gitlab:acme/app' }, { repository: 42 }, { bugs: null, homepage: [], repository: {} }]) {
      assert.deepEqual(getRepo(pkg), {}, JSON.stringify(pkg))
    }
  })

  it('throws only for what is not a package.json object', () => {
    for (const value of [null, undefined, 'package.json', ['a'], 42]) {
      assert.throws(() => getRepo(value), /getRepo: expected a package.json object/u, String(value))
    }
  })
})
