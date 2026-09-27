import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { GitHubError as ReadError } from '../github.js'
import { GitHubError, createWriteClient, parseGraphQLResponse } from '../github/write.js'
import { SHA, SHA2, forbidRequests, json, stubGitHub } from './github-stub.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const client = () => createWriteClient({ token: 't0ken' })

describe('createWriteClient', () => {
  it('needs a real token: a client that writes is never anonymous', () => {
    for (const options of [{}, { token: null }, { token: '' }, { token: 'a b' }]) {
      assert.throws(() => createWriteClient(options), /createWriteClient: token must be a non-empty string$/u, JSON.stringify(options))
    }
  })

  it('reads as the read client does, and writes', () => {
    assert.deepEqual(Object.keys(client()).toSorted(), [
      'createBranch', 'createCommit', 'createPR', 'forkRepo',
      'getCollaboratorPermission', 'getCurrentUser', 'getPullRequest', 'getRepo',
      'getRepoFile', 'getRepoHead', 'getRepoTarball', 'listUserRepos',
    ])
    assert.equal(GitHubError, ReadError)
  })
})

describe('forkRepo', () => {
  it('forks, with only the options it was given', async () => {
    const calls = stubGitHub(() => json({ full_name: 'me/app' }, 202))
    assert.deepEqual(await client().forkRepo({ repo: 'acme/app', defaultBranchOnly: true }), { full_name: 'me/app' })
    assert.deepEqual(calls[0], { ...calls[0], method: 'POST', url: 'https://api.github.com/repos/acme/app/forks', body: { default_branch_only: true } })
    await client().forkRepo({ repo: 'acme/app', name: 'app.fork', organization: 'my-org' })
    assert.deepEqual(calls[1].body, { name: 'app.fork', organization: 'my-org' })
  })

  it('refuses a bad name, organization or flag', async () => {
    const calls = forbidRequests()
    await assert.rejects(client().forkRepo({ repo: 'acme/app', name: '..' }), /forkRepo: name is not a repository name/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', name: '' }), /forkRepo: name is not a repository name/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', organization: 'my/org' }), /forkRepo: organization is not a GitHub login/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', defaultBranchOnly: 'yes' }), /forkRepo: defaultBranchOnly must be a boolean/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', org: 'x' }), /forkRepo: unknown option org/u)
    assert.deepEqual(calls, [])
  })
})

describe('createBranch', () => {
  it('branches at the given commit', async () => {
    const calls = stubGitHub(() => json({ ref: 'refs/heads/fix/it' }, 201))
    await client().createBranch({ repo: 'acme/app', branch: 'fix/it', oid: SHA })
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [['POST', 'https://api.github.com/repos/acme/app/git/refs', { ref: 'refs/heads/fix/it', sha: SHA }]])
  })

  it('branches at the default branch head when no oid is given', async () => {
    const calls = stubGitHub(({ url, method }) => {
      if (method === 'POST') return json({ ref: 'refs/heads/fix' }, 201)
      return url.endsWith('/repos/acme/app') ? json({ full_name: 'acme/app', default_branch: 'main' }) : json({ object: { sha: SHA } })
    })
    await client().createBranch({ repo: 'acme/app', branch: 'fix' })
    assert.deepEqual(calls.at(-1).body, { ref: 'refs/heads/fix', sha: SHA })
  })

  it('refuses a branch git would not take, or an oid that is not a full sha', async () => {
    const calls = forbidRequests()
    for (const branch of [undefined, '', 'refs/../x', 'a b', 'x.lock', '-x']) {
      await assert.rejects(client().createBranch({ repo: 'acme/app', branch, oid: SHA }), /createBranch: branch is not a branch or tag name/u, String(branch))
    }
    await assert.rejects(client().createBranch({ repo: 'acme/app', branch: 'x', oid: 'main' }), /createBranch: oid is not a full commit sha/u)
    assert.deepEqual(calls, [])
  })
})

describe('createCommit', () => {
  const commitBody = { data: { createCommitOnBranch: { commit: { oid: SHA2, url: `https://github.com/acme/app/commit/${SHA2}` } } } }

  it('commits through GraphQL, contents in base64, deletions by path', async () => {
    const calls = stubGitHub(() => json(commitBody))
    const commit = await client().createCommit({
      repo: 'acme/app',
      branch: 'fix',
      message: { headline: 'Fix it', body: 'Because.' },
      additions: [{ path: 'a.txt', contents: 'héllo' }, { path: 'dir/b.bin', contents: new Uint8Array([0, 255]) }],
      deletions: ['c.txt', { path: 'd.txt' }],
      expectedHeadOid: SHA,
    })
    assert.deepEqual(commit, commitBody.data.createCommitOnBranch.commit)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.github.com/graphql')
    assert.deepEqual(calls[0].body.variables.input, {
      branch: { repositoryNameWithOwner: 'acme/app', branchName: 'fix' },
      message: { headline: 'Fix it', body: 'Because.' },
      fileChanges: {
        additions: [{ path: 'a.txt', contents: 'aMOpbGxv' }, { path: 'dir/b.bin', contents: 'AP8=' }],
        deletions: [{ path: 'c.txt' }, { path: 'd.txt' }],
      },
      expectedHeadOid: SHA,
    })
  })

  it('reads the branch head first when no expectedHeadOid is given', async () => {
    const calls = stubGitHub(({ url }) => (url.endsWith('/graphql') ? json(commitBody) : json({ object: { sha: SHA } })))
    await client().createCommit({ repo: 'acme/app', branch: 'fix', message: 'Fix it' })
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/app/git/ref/heads/fix')
    assert.equal(calls[1].body.variables.input.expectedHeadOid, SHA)
  })

  it('refuses a message, a change or a head it cannot send as given', async () => {
    const calls = forbidRequests()
    const base = { repo: 'acme/app', branch: 'fix', expectedHeadOid: SHA }
    const bad = [
      [{ message: '' }, /message must be a non-empty string/u],
      [{ message: undefined }, /createCommit: message must be a string or \{ headline, body\? \}/u],
      [{ message: ['x'] }, /createCommit: message must be a string or \{ headline, body\? \}/u],
      [{ message: { headline: '' } }, /message.headline must be a non-empty string/u],
      [{ message: { headline: 'x', body: 7 } }, /message.body must be a string/u],
      [{ message: { headline: 'x', title: 'y' } }, /unknown option title/u],
      [{ message: 'x', additions: [{ path: '../x', contents: 'x' }] }, /additions\[0\].path is not a path inside a repository/u],
      [{ message: 'x', additions: [{ path: 'x', contents: 7 }] }, /Unsupported file contents type/u],
      [{ message: 'x', additions: [{ path: 'x', contents: 'x', mode: '100755' }] }, /unknown option mode/u],
      [{ message: 'x', additions: { path: 'x' } }, /additions must be an array/u],
      [{ message: 'x', deletions: ['a//b'] }, /deletions\[0\] is not a path inside a repository/u],
      [{ message: 'x', deletions: [{ path: 'x', why: 'y' }] }, /unknown option why/u],
      [{ message: 'x', expectedHeadOid: 'HEAD' }, /expectedHeadOid is not a full commit sha/u],
    ]
    for (const [options, error] of bad) {
      await assert.rejects(client().createCommit({ ...base, ...options }), error, JSON.stringify(options))
    }
    assert.deepEqual(calls, [])
  })
})

describe('createPR', () => {
  it('opens a pull request, from a branch or a fork', async () => {
    const calls = stubGitHub(() => json({ number: 7 }, 201))
    assert.deepEqual(await client().createPR({ repo: 'acme/app', title: 'Fix', head: 'me:fix/it', base: 'main', draft: true }), { number: 7 })
    assert.deepEqual(calls[0].body, { title: 'Fix', head: 'me:fix/it', base: 'main', draft: true })
    await client().createPR({ repo: 'acme/app', title: 'Fix', head: 'fix', base: 'main', body: 'Why.' })
    assert.deepEqual(calls[1].body, { title: 'Fix', head: 'fix', base: 'main', body: 'Why.' })
  })

  it('refuses a missing or malformed title, head, base or flag, as a rejection', async () => {
    const calls = forbidRequests()
    const base = { repo: 'acme/app', title: 'Fix', head: 'me:fix', base: 'main' }
    const bad = [
      [{ base: undefined }, /createPR: base is not a branch or tag name/u],
      [{ title: ' ' }, /createPR: title must be a non-empty string/u],
      [{ head: 'me:' }, /createPR: head branch is not a branch or tag name/u],
      [{ head: 'm/e:fix' }, /createPR: head owner is not a GitHub login/u],
      [{ head: 'a:b:c' }, /createPR: head branch is not a branch or tag name/u],
      [{ body: 7 }, /createPR: body must be a string/u],
      [{ draft: 1 }, /createPR: draft must be a boolean/u],
    ]
    for (const [options, error] of bad) {
      await assert.rejects(client().createPR({ ...base, ...options }), error, JSON.stringify(options))
    }
    assert.deepEqual(calls, [])
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
