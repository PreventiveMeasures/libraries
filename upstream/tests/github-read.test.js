import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError, createClient } from '../github.js'
import { SHA, forbidRequests, json, stubGitHub } from './github-stub.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const client = () => createClient({ token: 't0ken' })

describe('createClient', () => {
  it('needs a token, or null for an anonymous client', () => {
    for (const options of [{}, { token: undefined }, { token: '' }, { token: 'a b' }, { token: 't\n' }, { token: 42 }]) {
      assert.throws(() => createClient(options), /createClient: token must be a token, or null for anonymous access/u, JSON.stringify(options))
    }
    assert.throws(() => createClient(), /createClient: options must be an options object/u)
    assert.throws(() => createClient({ token: 't', usrAgent: 'x' }), /createClient: unknown option usrAgent/u)
    assert.throws(() => createClient({ token: 't', userAgent: '' }), /userAgent must be/u)
  })

  it('sends the token, the API version and a user agent on every request', async () => {
    const calls = stubGitHub(() => json({ login: 'octocat' }))
    assert.deepEqual(await client().getCurrentUser(), { login: 'octocat' })
    assert.equal(calls[0].url, 'https://api.github.com/user')
    assert.equal(calls[0].headers.Authorization, 'Bearer t0ken')
    assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28')
    assert.equal(calls[0].headers['User-Agent'], '@preventive/upstream')

    await createClient({ token: 't0ken', userAgent: 'mine' }).getCurrentUser()
    assert.equal(calls[1].headers['User-Agent'], 'mine')
  })

  it('sends no credentials at all when anonymous', async () => {
    const calls = stubGitHub(() => json({ full_name: 'acme/app' }))
    await createClient({ token: null }).getRepo({ repo: 'acme/app' })
    assert.equal('Authorization' in calls[0].headers, false)
  })

  it('reads, and nothing else', () => {
    assert.deepEqual(Object.keys(client()).toSorted(), [
      'getAdvisory', 'getCollaboratorPermission', 'getCurrentUser', 'getPullRequest', 'getRepo',
      'getRepoFile', 'getRepoHead', 'getRepoTarball', 'listUserRepos',
    ])
  })
})

describe('arguments, before any request', () => {
  it('takes a repo name with dots in it', async () => {
    const calls = stubGitHub(() => json({ object: { sha: SHA } }))
    await client().getRepoHead({ repo: 'socketio/socket.io', branch: 'main' })
    await client().getRepoHead({ repo: 'acme/.github', branch: 'main' })
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/repos/socketio/socket.io/git/ref/heads/main',
      'https://api.github.com/repos/acme/.github/git/ref/heads/main',
    ])
  })

  it('refuses a repo that is not `owner/name` by GitHub rules', async () => {
    const calls = forbidRequests()
    const bad = ['octocat', 'a/b/c', '../x', 'a/..', 'a/.', 'git.hub/x', '-acme/x', 'acme-/x', 'ac--me/x', `${'a'.repeat(40)}/x`, `a/${'x'.repeat(101)}`, 'a/b?c', 'a/b#c', 'a/b c', '', undefined, ['acme/app']]
    for (const repo of bad) {
      await assert.rejects(client().getRepo({ repo }), /getRepo: repo must be "owner\/name"/u, String(repo))
    }
    assert.deepEqual(calls, [])
  })

  it('refuses what must be an options object, an unknown option, or an argument too many', async () => {
    const calls = forbidRequests()
    await assert.rejects(client().getRepo(), /getRepo: options must be an options object/u)
    await assert.rejects(client().getRepo('acme/app'), /getRepo: options must be an options object/u)
    await assert.rejects(client().getRepo(null), /getRepo: options must be an options object/u)
    await assert.rejects(client().getRepoHead({ repo: 'acme/app', brnach: 'main' }), /getRepoHead: unknown option brnach/u)
    await assert.rejects(client().getRepo({ repo: 'acme/app' }, {}), /getRepo: unexpected arguments/u)
    await assert.rejects(client().getCurrentUser({}), /getCurrentUser: unexpected arguments/u)
    await assert.rejects(client().listUserRepos({ page: 2 }), /listUserRepos: unknown option page/u)
    await assert.rejects(client().listUserRepos({}, {}), /listUserRepos: unexpected arguments/u)
    assert.deepEqual(calls, [])
  })
})

describe('responses', () => {
  it('throws a HttpError with the status and body of a failed request', async () => {
    stubGitHub(() => new Response('{"message":"Not Found"}', { status: 404 }))
    await assert.rejects(client().getCurrentUser(), (err) => {
      assert.ok(err instanceof HttpError)
      assert.equal(err.status, 404)
      assert.equal(err.message, 'GET https://api.github.com/user 404: {"message":"Not Found"}')
      return true
    })
  })

  it('refuses a redirect rather than following it to another repo', async () => {
    const calls = stubGitHub(() => new Response('', { status: 301, headers: { location: 'https://api.github.com/repositories/1' } }))
    await assert.rejects(client().getRepo({ repo: 'acme/old-name' }), { name: 'HttpError', status: 301 })
    assert.equal(calls[0].redirect, 'manual')
  })
})

describe('getRepo', () => {
  it('answers the repository object', async () => {
    const calls = stubGitHub(() => json({ full_name: 'Acme/App', private: false }))
    assert.deepEqual(await client().getRepo({ repo: 'acme/app' }), { full_name: 'Acme/App', private: false })
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app')
  })

  it('refuses an answer about another repo', async () => {
    stubGitHub(() => json({ full_name: 'other/app' }))
    await assert.rejects(client().getRepo({ repo: 'acme/app' }), /getRepo: answered for "other\/app", not acme\/app/u)
  })
})

describe('getRepoHead', () => {
  it('finds the head of a named branch', async () => {
    const calls = stubGitHub(() => json({ object: { sha: SHA } }))
    assert.deepEqual(await client().getRepoHead({ repo: 'acme/app', branch: 'feat/x' }), { branch: 'feat/x', oid: SHA })
    assert.deepEqual(calls.map((c) => c.url), ['https://api.github.com/repos/acme/app/git/ref/heads/feat%2Fx'])
  })

  it('finds the default branch first when none is named', async () => {
    const calls = stubGitHub(({ url }) => (url.endsWith('/repos/acme/app') ? json({ full_name: 'acme/app', default_branch: 'main' }) : json({ object: { sha: SHA } })))
    assert.deepEqual(await client().getRepoHead({ repo: 'acme/app' }), { branch: 'main', oid: SHA })
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/repos/acme/app',
      'https://api.github.com/repos/acme/app/git/ref/heads/main',
    ])
  })

  it('refuses a branch git would not take, and an answer that must be a full sha', async () => {
    const calls = forbidRequests()
    for (const branch of ['', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '/a', 'a/', 'a//b', '.a', 'a/.b', 'a.lock', 'a.', '@', '-a', 'a@{1}', 'a\u0000b', 42]) {
      await assert.rejects(client().getRepoHead({ repo: 'acme/app', branch }), /getRepoHead: branch must be a branch or tag name/u, JSON.stringify(branch))
    }
    assert.deepEqual(calls, [])
    stubGitHub(() => json({ object: { sha: 'abc123' } }))
    await assert.rejects(client().getRepoHead({ repo: 'acme/app', branch: 'main' }), /getRepoHead: no commit sha for acme\/app@main/u)
  })
})

describe('getRepoFile', () => {
  it('reads a file raw, each path segment encoded, at a ref', async () => {
    const calls = stubGitHub(() => new Response('{ "name": "app" }', { headers: { 'content-type': 'application/vnd.github.raw' } }))
    assert.equal(await client().getRepoFile({ repo: 'acme/app', path: 'dir with space/package.json', ref: 'v1.0.0' }), '{ "name": "app" }')
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/contents/dir%20with%20space/package.json?ref=v1.0.0')
    assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw')
    await client().getRepoFile({ repo: 'acme/app', path: 'a.txt', ref: SHA })
    assert.equal(calls[1].url, `https://api.github.com/repos/acme/app/contents/a.txt?ref=${SHA}`)
  })

  it('encodes what URL parsing would otherwise read: a `%2e%2e`, a `#`, a `?`', async () => {
    const calls = stubGitHub(() => new Response('x'))
    await client().getRepoFile({ repo: 'acme/app', path: '%2e%2e/a#b?c/(d)', ref: 'feat/a#b' })
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/contents/%252e%252e/a%23b%3Fc/%28d%29?ref=feat%2Fa%23b')
    stubGitHub(() => json({ object: { sha: SHA } }))
    await client().getRepoHead({ repo: 'acme/app', branch: 'a#b' })
  })

  it('refuses a path that could step out of the repo, or a bad ref', async () => {
    const calls = forbidRequests()
    for (const path of ['', '../../user', 'a/../../b', './a', 'a/./b', '/a', 'a/', 'a//b', '.', '..', 'a\nb', 42, undefined]) {
      await assert.rejects(client().getRepoFile({ repo: 'acme/app', path }), /getRepoFile: path must be a path inside a repository/u, JSON.stringify(path))
    }
    await assert.rejects(client().getRepoFile({ repo: 'acme/app', path: 'a', ref: '../main' }), /getRepoFile: ref must be a branch or tag name/u)
    assert.deepEqual(calls, [])
  })
})

describe('getRepoTarball', () => {
  it('fetches the tarball at a commit, bytes intact, following the redirect', async () => {
    // Not valid UTF-8, so a body read as text would come back different.
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00])
    const calls = stubGitHub(() => new Response(bytes, { headers: { 'content-type': 'application/x-gzip' } }))
    const tarball = await client().getRepoTarball({ repo: 'acme/app', sha: SHA })
    assert.ok(tarball instanceof Uint8Array)
    assert.deepEqual(tarball, bytes)
    assert.equal(calls[0].url, `https://api.github.com/repos/acme/app/tarball/${SHA}`)
    assert.equal(calls[0].headers.Authorization, 'Bearer t0ken')
    assert.equal(calls[0].redirect, 'follow')
  })

  it('takes only a full commit sha, not a branch, a tag, a path or an abbreviation', async () => {
    const calls = forbidRequests()
    for (const sha of [undefined, '', 'main', 'v1.0.0', '..', 'abc123', SHA.toUpperCase(), `${SHA}/..`, `${SHA}0`, 'a'.repeat(65)]) {
      await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha }), /getRepoTarball: sha must be a full commit sha/u, String(sha))
    }
    assert.deepEqual(calls, [])
  })

  it('throws a HttpError for a failed tarball', async () => {
    stubGitHub(() => new Response('{"message":"No commit found"}', { status: 404 }))
    await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: SHA }), { name: 'HttpError', status: 404, message: `GET https://api.github.com/repos/acme/app/tarball/${SHA} 404: {"message":"No commit found"}` })
  })
})

describe('getPullRequest', () => {
  const pr = (fields) => ({ number: 7, title: 'Fix it', state: 'open', merged: false, draft: false, base: { repo: { full_name: 'Acme/App' } }, ...fields })

  it('answers the title and a status, merged over closed over draft over open', async () => {
    const cases = [[{}, 'open'], [{ draft: true }, 'draft'], [{ state: 'closed' }, 'closed'], [{ state: 'closed', merged: true }, 'merged'], [{ state: 'closed', draft: true }, 'closed']]
    for (const [fields, status] of cases) {
      const calls = stubGitHub(() => json(pr(fields)))
      assert.deepEqual(await client().getPullRequest({ repo: 'acme/app', number: 7 }), { title: 'Fix it', status }, JSON.stringify(fields))
      assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/pulls/7')
      assert.equal(calls[0].redirect, 'manual')
    }
  })

  it('refuses an answer about another pull request or another repo', async () => {
    for (const fields of [{ number: 8 }, { base: { repo: { full_name: 'other/app' } } }, { base: null }]) {
      stubGitHub(() => json(pr(fields)))
      await assert.rejects(client().getPullRequest({ repo: 'acme/app', number: 7 }), /getPullRequest: answered for/u, JSON.stringify(fields))
    }
  })

  it('refuses an answer with no title or no state', async () => {
    for (const fields of [{ title: '' }, { title: '  ' }, { title: 7 }, { state: 'merged' }, { merged: 'yes' }]) {
      stubGitHub(() => json(pr(fields)))
      await assert.rejects(client().getPullRequest({ repo: 'acme/app', number: 7 }), /getPullRequest: acme\/app#7 has no/u, JSON.stringify(fields))
    }
  })

  it('refuses a number that must be a positive integer', async () => {
    const calls = forbidRequests()
    for (const number of [0, -1, 1.5, '7', Number.NaN, Infinity, 2 ** 53, undefined]) {
      await assert.rejects(client().getPullRequest({ repo: 'acme/app', number }), /getPullRequest: number must be a positive integer/u, String(number))
    }
    assert.deepEqual(calls, [])
  })
})

describe('getAdvisory', () => {
  const GHSA = 'GHSA-xvch-5gv4-984h'

  it("answers GitHub's advisory, when it is the one asked for", async () => {
    const body = { ghsa_id: GHSA, cve_id: 'CVE-2021-44906', summary: 'Prototype Pollution in minimist' }
    const calls = stubGitHub(() => json(body))
    assert.deepEqual(await client().getAdvisory({ ghsa: GHSA }), body)
    assert.equal(calls[0].url, `https://api.github.com/advisories/${GHSA}`)
    stubGitHub(() => json({ ...body, ghsa_id: 'GHSA-vh95-rmgr-6w4m' }))
    await assert.rejects(client().getAdvisory({ ghsa: GHSA }), /getAdvisory: answered for "GHSA-vh95-rmgr-6w4m", not GHSA-xvch-5gv4-984h/u)
  })

  it('refuses what is not a GHSA id, before any request', async () => {
    const calls = forbidRequests()
    for (const ghsa of ['CVE-2021-44906', 'GHSA-xvch-5gv4', 'ghsa-xvch-5gv4-984h', 'GHSA-XVCH-5GV4-984H', 'GHSA-xvch-5gv4-984i', `${GHSA}/x`, `../${GHSA}`, undefined]) {
      await assert.rejects(client().getAdvisory({ ghsa }), /getAdvisory: ghsa must be a GHSA id/u, String(ghsa))
    }
    assert.deepEqual(calls, [])
  })
})

describe('getCollaboratorPermission', () => {
  it("answers GitHub's permission record", async () => {
    const body = { permission: 'write', role_name: 'maintain', user: { login: 'Octocat', id: 1 } }
    const calls = stubGitHub(() => json(body))
    assert.deepEqual(await client().getCollaboratorPermission({ repo: 'acme/app', username: 'octocat' }), body)
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/collaborators/octocat/permission')
  })

  it('refuses an answer about another user, and a username that must be a login', async () => {
    stubGitHub(() => json({ permission: 'admin', user: { login: 'someone-else', id: 2 } }))
    await assert.rejects(client().getCollaboratorPermission({ repo: 'acme/app', username: 'octocat' }), /answered for "someone-else", not octocat/u)
    const calls = forbidRequests()
    for (const username of ['', '../admin', 'a/b', 'octo cat', '-octo', 'x'.repeat(40), undefined]) {
      await assert.rejects(client().getCollaboratorPermission({ repo: 'acme/app', username }), /username must be a GitHub login/u, String(username))
    }
    assert.deepEqual(calls, [])
  })
})

describe('listUserRepos', () => {
  it('reads every page, until a short one', async () => {
    const page = (n, count) => Array.from({ length: count }, (_, i) => ({ full_name: `u/r${n}-${i}` }))
    const calls = stubGitHub(({ url }) => json(url.includes('page=1&') ? page(1, 100) : page(2, 3)))
    const repos = await client().listUserRepos()
    assert.equal(repos.length, 103)
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/user/repos?per_page=100&page=1&sort=full_name',
      'https://api.github.com/user/repos?per_page=100&page=2&sort=full_name',
    ])
  })

  it('stops at 100 pages rather than read on without end', async () => {
    const calls = stubGitHub(() => json(Array.from({ length: 100 }, () => ({}))))
    await assert.rejects(client().listUserRepos(), /listUserRepos: more than 100 pages/u)
    assert.equal(calls.length, 101)
  })

  it('stops at maxPages when given one, and refuses one that is not a positive integer', async () => {
    const calls = stubGitHub(() => json(Array.from({ length: 100 }, () => ({}))))
    await assert.rejects(client().listUserRepos({ maxPages: 2 }), /listUserRepos: more than 2 pages/u)
    assert.equal(calls.length, 3)
    for (const maxPages of [0, -1, 1.5, '2', null]) {
      await assert.rejects(client().listUserRepos({ maxPages }), /listUserRepos: maxPages must be a positive integer/u, String(maxPages))
    }
    await assert.rejects(client().listUserRepos(null), /listUserRepos: options must be an options object/u)
    assert.equal(calls.length, 3)
  })

  it('answers a list of exactly maxPages full pages, once the next page comes back empty', async () => {
    const full = Array.from({ length: 100 }, () => ({}))
    const calls = stubGitHub(({ url }) => json(url.includes('page=3&') ? [] : full))
    assert.equal((await client().listUserRepos({ maxPages: 2 })).length, 200)
    assert.equal(calls.length, 3)
  })

  it('refuses a page that must be a list', async () => {
    stubGitHub(() => json({ message: 'odd' }))
    await assert.rejects(client().listUserRepos(), /listUserRepos: expected an array for page 1/u)
  })
})
