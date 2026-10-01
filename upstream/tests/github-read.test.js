import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
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
      'getRepoFile', 'getRepoHead', 'getRepoTarball', 'getRepoTreeId', 'getRepoTreeTarball', 'listRepoAdvisories', 'listRepoDir', 'listUserRepos',
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
  // git's id for a blob: the sha1 of a header and the bytes.
  const blobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const fileAt = (path, text, overrides = {}) => json({ type: 'file', path, size: Buffer.byteLength(text), sha: blobSha(Buffer.from(text)), encoding: 'base64', content: `${Buffer.from(text).toString('base64')}\n`, ...overrides })
  const bigFile = (bytes, overrides = {}) => json({ type: 'file', path: 'big.txt', size: bytes.length, sha: blobSha(bytes), encoding: 'none', content: '', ...overrides })

  it("reads a file's content off GitHub's object for it, each path segment encoded, at a ref", async () => {
    const calls = stubGitHub(({ url }) => fileAt(url.includes('package.json') ? 'dir with space/package.json' : 'a.txt', 'héllo { "name": "app" }'))
    assert.equal(await client().getRepoFile({ repo: 'acme/app', path: 'dir with space/package.json', ref: 'v1.0.0' }), 'héllo { "name": "app" }')
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/contents/dir%20with%20space/package.json?ref=v1.0.0')
    assert.equal(calls[0].headers.Accept, 'application/vnd.github+json')
    await client().getRepoFile({ repo: 'acme/app', path: 'a.txt', ref: SHA })
    assert.equal(calls[1].url, `https://api.github.com/repos/acme/app/contents/a.txt?ref=${SHA}`)
  })

  it('reads a file past 1 MB as the blob its object names, which no later push can change', async () => {
    const bytes = Buffer.from('big')
    const calls = stubGitHub(({ headers }) => (headers.Accept === 'application/vnd.github.raw' ? new Response(bytes) : bigFile(bytes)))
    assert.equal(await client().getRepoFile({ repo: 'acme/app', path: 'big.txt', ref: 'main' }), 'big')
    assert.deepEqual(calls.map((call) => [call.url, call.headers.Accept]), [
      ['https://api.github.com/repos/acme/app/contents/big.txt?ref=main', 'application/vnd.github+json'],
      [`https://api.github.com/repos/acme/app/git/blobs/${blobSha(bytes)}`, 'application/vnd.github.raw'],
    ])
  })

  it('refuses a blob that does not hash to what the object named', async () => {
    const bytes = Buffer.from('big')
    for (const served of [Buffer.from('bag'), Buffer.from('bigger'), Buffer.from('[{"type":"dir"}]')]) {
      stubGitHub(({ headers }) => (headers.Accept === 'application/vnd.github.raw' ? new Response(served) : bigFile(bytes)))
      await assert.rejects(client().getRepoFile({ repo: 'acme/app', path: 'big.txt' }), new RegExp(`getRepoFile: "big.txt" came back as blob ${blobSha(served)}, not ${blobSha(bytes)}`, 'u'))
    }
  })

  it('refuses a directory, a symlink, another path, or content that is not what it says', async () => {
    for (const [answer, error] of [
      [json([{ type: 'file', path: 'dir/a.txt', size: 1 }]), /getRepoFile: acme\/app has no file at "dir"/u],
      [json({ type: 'symlink', path: 'dir', size: 5, target: 'other' }), /getRepoFile: acme\/app has no file at "dir"/u],
      [json({ type: 'submodule', path: 'dir', size: 0 }), /getRepoFile: acme\/app has no file at "dir"/u],
      [fileAt('other', 'x'), /getRepoFile: acme\/app has no file at "dir"/u],
      [fileAt('dir', 'x', { sha: undefined }), /getRepoFile: acme\/app has no file at "dir"/u],
      [fileAt('dir', 'x', { encoding: 'utf-8' }), /getRepoFile: unexpected encoding for "dir"/u],
      [fileAt('dir', 'x', { content: '!!' }), /getRepoFile: unexpected encoding for "dir"/u],
      [fileAt('dir', 'xyz', { size: 2 }), /getRepoFile: "dir" came back as blob/u],
      [fileAt('dir', 'xyz', { sha: blobSha(Buffer.from('xyw')) }), /getRepoFile: "dir" came back as blob/u],
      [fileAt('dir', 'x', { content: Buffer.from([0xff]).toString('base64'), size: 1, sha: blobSha(Buffer.from([0xff])) }), /Malformed UTF-8/u],
    ]) {
      const calls = stubGitHub(() => answer.clone())
      await assert.rejects(client().getRepoFile({ repo: 'acme/app', path: 'dir' }), error)
      assert.equal(calls.length, 1)
    }
  })

  it('encodes what URL parsing would otherwise read: a `%2e%2e`, a `#`, a `?`', async () => {
    const calls = stubGitHub(() => fileAt('%2e%2e/a#b?c/(d)', 'x'))
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

  it("reads the repository's copy first, and the global one when the repository fails", async () => {
    const repoCopy = { ghsa_id: GHSA, state: 'published', summary: 'Prototype Pollution in minimist (updated)' }
    const globalCopy = { ghsa_id: GHSA, type: 'reviewed', summary: 'Prototype Pollution in minimist' }
    const REPO_URL = `https://api.github.com/repos/minimistjs/minimist/security-advisories/${GHSA}`
    const GLOBAL_URL = `https://api.github.com/advisories/${GHSA}`
    let calls = stubGitHub(({ url }) => json(url === REPO_URL ? repoCopy : globalCopy))
    assert.deepEqual(await client().getAdvisory({ ghsa: GHSA, repo: 'minimistjs/minimist' }), repoCopy)
    assert.deepEqual(calls.map((call) => call.url), [REPO_URL])
    for (const failed of [json({ message: 'Not Found' }, 404), json({ message: 'Repository access blocked' }, 451), new Response('', { status: 301, headers: { location: 'https://api.github.com/repositories/1' } })]) {
      calls = stubGitHub(({ url }) => (url === REPO_URL ? failed.clone() : json(globalCopy)))
      assert.deepEqual(await client().getAdvisory({ ghsa: GHSA, repo: 'minimistjs/minimist' }), globalCopy)
      assert.deepEqual(calls.map((call) => call.url), [REPO_URL, GLOBAL_URL])
    }
    calls = stubGitHub(() => json(globalCopy))
    await client().getAdvisory({ ghsa: GHSA })
    assert.deepEqual(calls.map((call) => call.url), [GLOBAL_URL])
  })

  it('throws, rather than answer the global copy, when the repository fails without being gone', async () => {
    for (const status of [403, 429, 500, 503]) {
      const calls = stubGitHub(({ url }) => (url.includes('/repos/') ? json({ message: 'x' }, status) : json({ ghsa_id: GHSA })))
      await assert.rejects(client().getAdvisory({ ghsa: GHSA, repo: 'minimistjs/minimist' }), { name: 'HttpError', status }, String(status))
      assert.equal(calls.length, 1)
    }
  })

  it("refuses a repository copy that is not published, or not the one asked for, rather than falling back", async () => {
    const calls = stubGitHub(({ url }) => json(url.includes('/repos/') ? { ghsa_id: GHSA, state: 'draft' } : { ghsa_id: GHSA }))
    await assert.rejects(client().getAdvisory({ ghsa: GHSA, repo: 'minimistjs/minimist' }), /getAdvisory: GHSA-xvch-5gv4-984h is "draft", not published/u)
    stubGitHub(() => json({ ghsa_id: 'GHSA-vh95-rmgr-6w4m', state: 'published' }))
    await assert.rejects(client().getAdvisory({ ghsa: GHSA, repo: 'minimistjs/minimist' }), /getAdvisory: answered for "GHSA-vh95-rmgr-6w4m"/u)
    assert.equal(calls.length, 1)
    await assert.rejects(client().getAdvisory({ ghsa: GHSA, repo: 'minimist' }), /getAdvisory: repo must be "owner\/name"/u)
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
