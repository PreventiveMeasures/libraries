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

  it('reads a repo name with dots off a tracker, and GitHub\'s host and the scheme in any case', () => {
    assert.deepEqual(getRepo({ bugs: { url: 'https://github.com/socketio/socket.io/issues' } }), { github: 'socketio/socket.io', url: 'https://github.com/socketio/socket.io' })
    assert.deepEqual(getRepo({ bugs: 'https://github.com/acme/app/issues/' }), { github: 'acme/app', url: 'https://github.com/acme/app' })
    assert.deepEqual(getRepo({ bugs: 'https://github.com/acme/app/issues//' }), {})
    for (const pkg of [
      { bugs: 'https://GitHub.com/acme/app/issues' },
      { bugs: 'HTTPS://github.com/acme/app/issues' },
      { repository: 'https://GitHub.com/acme/app.git' },
      { repository: 'HTTPS://github.com/acme/app.git' },
      { repository: 'GIT+HTTPS://github.com/acme/app.git' },
      { repository: 'Git+Ssh://git@github.com:acme/app.git' },
      { repository: 'SSH://git@github.com/acme/app.git' },
      { repository: 'git+ssh://git@GITHUB.COM/acme/app.git' },
      { repository: 'git@GitHub.com:acme/app.git' },
      { repository: 'ssh://git@github.com:22/acme/app.git' },
      { repository: 'https://github.com:443/acme/app.git' },
      { bugs: 'https://github.com:443/acme/app/issues' },
      { homepage: 'https://github.com:443/acme/app#readme' },
      { homepage: 'https://GitHub.com/acme/app#readme' },
      { homepage: 'https://github.com/acme/app/tree/main' },
      { homepage: 'https://github.com/acme/app/tree/main/' },
    ]) {
      assert.deepEqual(getRepo(pkg), { github: 'acme/app', url: 'https://github.com/acme/app' }, JSON.stringify(pkg))
    }
    assert.deepEqual(getRepo({ homepage: 'https://github.com/acme/app/tree/main/packages/x/' }), { github: 'acme/app', directory: 'packages/x', url: 'https://github.com/acme/app' })
    assert.deepEqual(getRepo({ homepage: 'https://github.com:443/acme/app/tree/main/packages/x' }), { github: 'acme/app', directory: 'packages/x', url: 'https://github.com/acme/app' })
    // A URL's path is percent-encoded; the directory is the tree path it spells.
    assert.deepEqual(getRepo({ homepage: 'https://github.com/acme/app/tree/main/my%20dir/caf%C3%A9%23x' }), { github: 'acme/app', directory: 'my dir/café#x', url: 'https://github.com/acme/app' })
    for (const directory of ['%2e%2e/x', 'a/%2E/b', 'a%2F%2Fb', '%00x', 'caf%C3', 'a%zz']) {
      assert.deepEqual(getRepo({ homepage: `https://github.com/acme/app/tree/main/${directory}` }), { github: 'acme/app', url: 'https://github.com/acme/app' }, directory)
    }
    for (const pkg of [{ homepage: 'https://github.com/acme/app/tree' }, { homepage: 'https://github.com/acme/app/blob/main/README.md' }, { bugs: 'https://github.com/acme/../issues' }, { repository: 'https://GitHub.com.evil.example/acme/app' }, { repository: 'git@GitHub.com.evil.example:acme/app' }, { repository: 'https://github.com:443@evil.example/acme/app' }, { bugs: 'https://github.com:443@evil.example/acme/app/issues' }, { homepage: 'https://github.com:443@evil.example/acme/app' }, { homepage: 'https://github.com:x/acme/app' }, { bugs: 'https://github.com:x/acme/app/issues' }, { repository: 'https://github.com:x/acme/app' }]) {
      assert.deepEqual(getRepo(pkg), {}, JSON.stringify(pkg))
    }
  })

  it('takes any directory git could have, but no traversal or empty part', () => {
    const at = (directory) => getRepo({ repository: { url: 'https://github.com/acme/mono', directory } }).directory
    for (const directory of ['packages/@scope/pkg', 'packages/café', 'my dir/pkg', '.github/actions/x', 'a+b/c~d']) assert.equal(at(directory), directory)
    for (const directory of ['../x', 'a/../b', 'a//b', 'a/./b', '.git/x', 'a/.GIT', 'a\u0000b', 'a\u0007b']) assert.equal(at(directory), undefined, JSON.stringify(directory))
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
