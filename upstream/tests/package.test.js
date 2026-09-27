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

  it('reads a repo name with dots off a tracker, and GitHub\'s host in any case', () => {
    assert.deepEqual(getRepo({ bugs: { url: 'https://github.com/socketio/socket.io/issues' } }), { github: 'socketio/socket.io', url: 'https://github.com/socketio/socket.io' })
    for (const pkg of [
      { bugs: 'https://GitHub.com/acme/app/issues' },
      { repository: 'https://GitHub.com/acme/app.git' },
      { repository: 'git+ssh://git@GITHUB.COM/acme/app.git' },
      { repository: 'git@GitHub.com:acme/app.git' },
      { homepage: 'https://GitHub.com/acme/app#readme' },
    ]) {
      assert.deepEqual(getRepo(pkg), { github: 'acme/app', url: 'https://github.com/acme/app' }, JSON.stringify(pkg))
    }
    for (const pkg of [{ bugs: 'https://github.com/acme/../issues' }, { repository: 'https://GitHub.com.evil.example/acme/app' }, { repository: 'git@GitHub.com.evil.example:acme/app' }]) {
      assert.deepEqual(getRepo(pkg), {}, JSON.stringify(pkg))
    }
  })

  it('answers the directory with the repo, never without it', () => {
    assert.deepEqual(getRepo({ repository: { type: 'git', url: 'git+https://github.com/babel/babel.git', directory: 'packages/babel-core' } }), { github: 'babel/babel', directory: 'packages/babel-core', url: 'https://github.com/babel/babel' })
    assert.deepEqual(getRepo({ repository: { url: 'https://gitlab.com/acme/app.git', directory: 'packages/x' } }), {})
    const tracker = { bugs: 'https://github.com/acme/app/issues' }
    for (const repository of [{ url: 'https://gitlab.com/other/mono.git', directory: 'packages/x' }, { url: 'not a url', directory: 'packages/x' }, { directory: 'packages/x' }]) {
      assert.deepEqual(getRepo({ ...tracker, repository }), { github: 'acme/app', url: 'https://github.com/acme/app' }, JSON.stringify(repository))
    }
    assert.deepEqual(getRepo({ ...tracker, repository: { url: 'git+https://github.com/Acme/App.git', directory: 'packages/x' } }), { github: 'acme/app', directory: 'packages/x', url: 'https://github.com/acme/app' })
  })

  it('answers nothing, rather than throwing, where nothing names a GitHub repo', () => {
    for (const pkg of [{}, { name: 'x' }, { homepage: 'https://example.com' }, { repository: 'gitlab:acme/app' }, { repository: 42 }, { bugs: null, homepage: [], repository: {} }]) {
      assert.deepEqual(getRepo(pkg), {}, JSON.stringify(pkg))
    }
  })

  it('answers a url only for a GitHub repo it parsed, and only as that repo\'s GitHub page', () => {
    const pkgs = [
      { repository: 'gitlab:acme/app' },
      { repository: 'bitbucket:acme/app' },
      { repository: 'https://gitlab.com/acme/app.git' },
      { repository: 'https://git.internal.example/acme/app.git' },
      { repository: 'https://token@github.com.evil.example/acme/app' },
      { repository: 'https://evil.example#@github.com/acme/app' },
      { repository: 'https://evil.example?@github.com/acme/app' },
      { repository: 'https://evil.example\\@github.com/acme/app' },
      { homepage: 'https://acme.example/docs' },
      { bugs: 'https://tracker.example/acme/issues' },
      { repository: 'git+https://user:secret@github.com/acme/app.git' },
      { repository: 'git@github.com:acme/app.git', homepage: 'https://acme.example' },
      { bugs: { url: 'http://github.com/acme/app/issues' } },
      { homepage: 'https://www.github.com/Acme/App/tree/main/pkg#readme' },
    ]
    for (const pkg of pkgs) {
      const link = getRepo(pkg)
      if (link.github === undefined) {
        assert.deepEqual(link, {}, JSON.stringify(pkg))
      } else {
        assert.equal(link.url, `https://github.com/${link.github}`, JSON.stringify(pkg))
        assert.doesNotMatch(JSON.stringify(link), /secret|token|www\.|http:|\.git\b|git@|#/u, JSON.stringify(pkg))
      }
    }
  })

  it('throws only for what is not a package.json object', () => {
    for (const value of [null, undefined, 'package.json', ['a'], 42]) {
      assert.throws(() => getRepo(value), /getRepo: expected a package.json object/u, String(value))
    }
  })
})
