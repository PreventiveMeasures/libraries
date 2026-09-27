import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createClient, parseGraphQLResponse } from '../github.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

// Answers each request with `respond(call)` and keeps every one
// it was asked, so a test can check what went over the wire.
function stubGitHub(respond) {
  const calls = []
  globalThis.fetch = (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', headers: options.headers, body: options.body && JSON.parse(options.body) }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return calls
}

const client = () => createClient({ token: 't0ken' })

describe('createClient', () => {
  it('needs a token', () => {
    assert.throws(() => createClient({}), /Missing GitHub token/u)
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

  it('takes a repo name with dots in it', async () => {
    const calls = stubGitHub(() => json({ object: { sha: 'abc123' } }))
    await client().getRepoHead({ repo: 'socketio/socket.io', branch: 'main' })
    await client().getRepoHead({ repo: 'acme/.github', branch: 'main' })
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/repos/socketio/socket.io/git/ref/heads/main',
      'https://api.github.com/repos/acme/.github/git/ref/heads/main',
    ])
  })

  it('refuses a repo that is not `owner/name`', async () => {
    stubGitHub(() => assert.fail('no request expected'))
    for (const repo of ['octocat', 'a/b/c', '../x', 'a/..', 'a/.', 'git.hub/x', 'a/b?c', '', undefined]) {
      await assert.rejects(client().getRepoHead({ repo }), /Expected "owner\/name"/u, String(repo))
    }
  })

  it('throws with the status and body of a failed request', async () => {
    stubGitHub(() => new Response('{"message":"Not Found"}', { status: 404 }))
    await assert.rejects(client().getCurrentUser(), /GitHub GET \/user 404: \{"message":"Not Found"\}/u)
  })
})

describe('reading a repo', () => {
  it('finds the head of a named branch', async () => {
    const calls = stubGitHub(() => json({ object: { sha: 'abc123' } }))
    assert.deepEqual(await client().getRepoHead({ repo: 'acme/app', branch: 'feat/x' }), { branch: 'feat/x', oid: 'abc123' })
    assert.deepEqual(calls.map((c) => c.url), ['https://api.github.com/repos/acme/app/git/ref/heads/feat%2Fx'])
  })

  it('finds the default branch first when none is named', async () => {
    const calls = stubGitHub(({ url }) => (url.endsWith('/repos/acme/app') ? json({ default_branch: 'main' }) : json({ object: { sha: 'abc123' } })))
    assert.deepEqual(await client().getRepoHead({ repo: 'acme/app' }), { branch: 'main', oid: 'abc123' })
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/repos/acme/app',
      'https://api.github.com/repos/acme/app/git/ref/heads/main',
    ])
  })

  it('reads a file raw, each path segment encoded, at a ref', async () => {
    const calls = stubGitHub(() => new Response('{ "name": "app" }', { headers: { 'content-type': 'application/vnd.github.raw' } }))
    assert.equal(await client().getRepoFile({ repo: 'acme/app', path: 'dir with space/package.json', ref: 'v1.0.0' }), '{ "name": "app" }')
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/contents/dir%20with%20space/package.json?ref=v1.0.0')
    assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw')
  })

  it('fetches the tarball at a commit, bytes intact', async () => {
    // Not valid UTF-8, so a body read as text would come back different.
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x00])
    const calls = stubGitHub(() => new Response(bytes, { headers: { 'content-type': 'application/x-gzip' } }))
    const tarball = await client().getRepoTarball({ repo: 'acme/app', sha: 'abc123' })
    assert.ok(tarball instanceof Uint8Array)
    assert.deepEqual(tarball, bytes)
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/tarball/abc123')
    assert.equal(calls[0].headers.Authorization, 'Bearer t0ken')
  })

  it('takes only a commit sha for the tarball, not a branch, a tag or a path', async () => {
    stubGitHub(() => assert.fail('no request expected'))
    for (const sha of [undefined, '', 'main', 'v1.0.0', '..', 'abc', 'abc123/..', 'a'.repeat(65)]) {
      await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha }), /requires a commit sha/u, String(sha))
    }
  })

  it('throws with the status and body of a failed tarball', async () => {
    stubGitHub(() => new Response('{"message":"No commit found for SHA: dead"}', { status: 404 }))
    await assert.rejects(client().getRepoTarball({ repo: 'acme/app', sha: 'dead' }), { message: 'GitHub GET /repos/acme/app/tarball/dead 404: {"message":"No commit found for SHA: dead"}' })
  })
})

describe('writing to a repo', () => {
  it('forks, with only the options it was given', async () => {
    const calls = stubGitHub(() => json({ full_name: 'me/app' }, 202))
    assert.deepEqual(await client().forkRepo({ repo: 'acme/app', defaultBranchOnly: true }), { full_name: 'me/app' })
    assert.deepEqual(calls[0], { ...calls[0], method: 'POST', url: 'https://api.github.com/repos/acme/app/forks', body: { default_branch_only: true } })
  })

  it('branches at the default branch head when no oid is given', async () => {
    const calls = stubGitHub(({ url, method }) => {
      if (method === 'POST') return json({ ref: 'refs/heads/fix' }, 201)
      return url.endsWith('/repos/acme/app') ? json({ default_branch: 'main' }) : json({ object: { sha: 'abc123' } })
    })
    await client().createBranch({ repo: 'acme/app', branch: 'fix' })
    assert.deepEqual(calls.at(-1).body, { ref: 'refs/heads/fix', sha: 'abc123' })
  })

  it('commits through GraphQL, contents in base64, deletions by path', async () => {
    const calls = stubGitHub(() => json({ data: { createCommitOnBranch: { commit: { oid: 'def456', url: 'https://github.com/acme/app/commit/def456' } } } }))
    const commit = await client().createCommit({
      repo: 'acme/app',
      branch: 'fix',
      message: { headline: 'Fix it', body: 'Because.' },
      additions: [{ path: 'a.txt', contents: 'héllo' }, { path: 'b.bin', contents: new Uint8Array([0, 255]) }],
      deletions: ['c.txt', { path: 'd.txt' }],
      expectedHeadOid: 'abc123',
    })
    assert.deepEqual(commit, { oid: 'def456', url: 'https://github.com/acme/app/commit/def456' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.github.com/graphql')
    assert.deepEqual(calls[0].body.variables.input, {
      branch: { repositoryNameWithOwner: 'acme/app', branchName: 'fix' },
      message: { headline: 'Fix it', body: 'Because.' },
      fileChanges: {
        additions: [{ path: 'a.txt', contents: 'aMOpbGxv' }, { path: 'b.bin', contents: 'AP8=' }],
        deletions: [{ path: 'c.txt' }, { path: 'd.txt' }],
      },
      expectedHeadOid: 'abc123',
    })
  })

  it('opens a pull request', async () => {
    const calls = stubGitHub(() => json({ number: 7 }, 201))
    assert.deepEqual(await client().createPR({ repo: 'acme/app', title: 'Fix', head: 'me:fix', base: 'main', draft: true }), { number: 7 })
    assert.deepEqual(calls[0].body, { title: 'Fix', head: 'me:fix', base: 'main', draft: true })
    assert.throws(() => client().createPR({ repo: 'acme/app', title: 'Fix', head: 'me:fix' }), /requires title, head, and base/u)
  })
})

describe('parseGraphQLResponse', () => {
  it('answers the data', () => {
    assert.deepEqual(parseGraphQLResponse(200, '{"data":{"a":1}}'), { a: 1 })
  })

  it('carries the status and the body of a transport error', () => {
    assert.throws(() => parseGraphQLResponse(502, '<html>Bad Gateway</html>'), { message: 'GitHub GraphQL 502: <html>Bad Gateway</html>' })
    assert.throws(() => parseGraphQLResponse(401, ''), { message: 'GitHub GraphQL 401: (empty body)' })
  })

  it('says a body is malformed, and keeps the parse error as the cause', () => {
    assert.throws(() => parseGraphQLResponse(200, 'not json'), (err) => {
      assert.match(err.message, /^GitHub GraphQL 200: malformed JSON response \(.+\): not json$/u)
      assert.ok(err.cause instanceof SyntaxError)
      return true
    })
  })

  it('throws on errors in an otherwise good response', () => {
    assert.throws(() => parseGraphQLResponse(200, '{"errors":[{"message":"nope"}]}'), { message: 'GitHub GraphQL: [{"message":"nope"}]' })
  })
})
