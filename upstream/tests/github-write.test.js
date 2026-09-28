import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError as ReadError } from '../github.js'
import { HttpError, createWriteClient, parseGraphQLResponse } from '../github/write.js'
import { SHA, SHA2, forbidRequests, json, stubGitHub } from './github-stub.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const client = () => createWriteClient({ token: 't0ken' })

describe('createWriteClient', () => {
  it('needs a real token: a client that writes is never anonymous', () => {
    for (const options of [{}, { token: null }, { token: '' }, { token: 'a b' }]) {
      assert.throws(() => createWriteClient(options), /createWriteClient: token must be a token, got/u, JSON.stringify(options))
    }
  })

  it('reads as the read client does, and writes', () => {
    assert.deepEqual(Object.keys(client()).toSorted(), [
      'createBranch', 'createCommit', 'createPR', 'forkRepo',
      'getAdvisory', 'getCollaboratorPermission', 'getCurrentUser', 'getPullRequest', 'getRepo',
      'getRepoFile', 'getRepoHead', 'getRepoTarball', 'listRepoAdvisories', 'listUserRepos',
    ])
    assert.equal(HttpError, ReadError)
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
    await assert.rejects(client().forkRepo({ repo: 'acme/app', name: '..' }), /forkRepo: name must be a repository name/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', name: '' }), /forkRepo: name must be a repository name/u)
    await assert.rejects(client().forkRepo({ repo: 'acme/app', organization: 'my/org' }), /forkRepo: organization must be a GitHub login/u)
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

  it('refuses a branch git would not take, or an oid that must be a full sha', async () => {
    const calls = forbidRequests()
    for (const branch of [undefined, '', 'refs/../x', 'a b', 'x.lock', '-x']) {
      await assert.rejects(client().createBranch({ repo: 'acme/app', branch, oid: SHA }), /createBranch: branch must be a branch or tag name/u, String(branch))
    }
    await assert.rejects(client().createBranch({ repo: 'acme/app', branch: 'x', oid: 'main' }), /createBranch: oid must be a full commit sha/u)
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

  it('refuses a GraphQL answer that is not UTF-8', async () => {
    stubGitHub(() => new Response(new Uint8Array([0x7B, 0xFF, 0x7D])))
    await assert.rejects(client().createCommit({ repo: 'acme/app', branch: 'fix', message: 'Fix it', expectedHeadOid: SHA }), { message: 'Malformed UTF-8 from GitHub GraphQL' })
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
      [{ message: '' }, /createCommit: message must be a non-empty single line/u],
      [{ message: 'Fix\nit' }, /createCommit: message must be a non-empty single line, got "Fix\\nit"/u],
      [{ message: undefined }, /createCommit: message must be an options object/u],
      [{ message: ['x'] }, /createCommit: message must be an options object/u],
      [{ message: { headline: '' } }, /message.headline must be a non-empty single line/u],
      [{ message: { headline: 'x', body: 7 } }, /message.body must be text with no control characters/u],
      [{ message: { headline: 'x', title: 'y' } }, /createCommit: unknown option message.title/u],
      [{ message: 'x', additions: [{ path: '../x', contents: 'x' }] }, /additions\[0\].path must be a path inside a repository/u],
      [{ message: 'x', additions: [{ path: 'x', contents: 7 }] }, /createCommit: additions\[0\].contents must be a well-formed string or a Uint8Array, got number/u],
      [{ message: 'x', additions: [{ path: 'x', contents: 'a\uD800b' }] }, /createCommit: additions\[0\].contents must be a well-formed string or a Uint8Array, got a malformed string/u],
      [{ message: 'x', additions: [{ path: 'x', contents: 'x', mode: '100755' }] }, /createCommit: unknown option additions\[0\].mode/u],
      [{ message: 'x', additions: { path: 'x' } }, /additions must be an array/u],
      [{ message: 'x', deletions: ['a//b'] }, /deletions\[0\] must be a path inside a repository/u],
      [{ message: 'x', additions: [{ path: 'a', contents: '' }], deletions: ['a'] }, /deletions\[0\] names "a" a second time/u],
      [{ message: 'x', additions: [{ path: 'a', contents: '' }, { path: 'a', contents: '' }] }, /additions\[1\].path names "a" a second time/u],
      [{ message: { headline: 'x', body: 'a\u0000b' } }, /message.body must be text with no control characters/u],
      [{ message: 'x', deletions: [{ path: 'x', why: 'y' }] }, /createCommit: unknown option deletions\[0\].why/u],
      [{ message: 'x', expectedHeadOid: 'HEAD' }, /expectedHeadOid must be a full commit sha/u],
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
      [{ base: undefined }, /createPR: base must be a branch or tag name/u],
      [{ title: ' ' }, /createPR: title must be a non-empty single line/u],
      [{ head: 'me:' }, /createPR: head branch must be a branch or tag name/u],
      [{ head: 'm/e:fix' }, /createPR: head owner must be a GitHub login/u],
      [{ head: 'a:b:c' }, /createPR: head branch must be a branch or tag name/u],
      [{ body: 7 }, /createPR: body must be text with no control characters/u],
      [{ title: 'Fix\r\nit' }, /createPR: title must be a non-empty single line/u],
      [{ draft: 1 }, /createPR: draft must be a boolean/u],
    ]
    for (const [options, error] of bad) {
      await assert.rejects(client().createPR({ ...base, ...options }), error, JSON.stringify(options))
    }
    assert.deepEqual(calls, [])
  })
})

describe('string formats', () => {
  it('refuses an options object that is not a plain one', async () => {
    const calls = forbidRequests()
    const inherited = Object.create({ draft: 'yes' })
    Object.assign(inherited, { repo: 'acme/app', title: 'Fix', head: 'fix', base: 'main' })
    await assert.rejects(client().createPR(inherited), /createPR: options must be an options object, got object/u)
    class Options { repo = 'acme/app' }
    await assert.rejects(client().getRepo(new Options()), /getRepo: options must be an options object/u)
    await assert.rejects(client().getRepo({ repo: 'acme/app', [Symbol('x')]: 1 }), /getRepo: unknown option Symbol\(x\)/u)
    assert.deepEqual(calls, [])
  })

  it('refuses a string that is not well-formed, too long, or reaches into .git', async () => {
    const calls = forbidRequests()
    const base = { repo: 'acme/app', branch: 'fix', expectedHeadOid: SHA }
    const bad = [
      [{ message: 'lone \uD800 surrogate' }, /message must be a non-empty single line/u],
      [{ message: 'x'.repeat(1025) }, /message must be a non-empty single line/u],
      [{ message: { headline: 'x', body: 'x'.repeat(65_537) } }, /message.body must be text/u],
      [{ message: { headline: 'x', body: 'c1 \u0085 control' } }, /message.body must be text/u],
      [{ message: 'x', additions: [{ path: '.git/hooks/post-checkout', contents: '' }] }, /additions\[0\].path must be a path inside a repository/u],
      [{ message: 'x', deletions: ['sub/.GIT/config'] }, /deletions\[0\] must be a path inside a repository/u],
      [{ message: 'x', deletions: ['a\uDC00'] }, /deletions\[0\] must be a path inside a repository/u],
    ]
    for (const [options, error] of bad) {
      await assert.rejects(client().createCommit({ ...base, ...options }), error, JSON.stringify(options))
    }
    await assert.rejects(client().getRepoFile({ repo: 'acme/app', path: 'a\uD800' }), /path must be a path inside a repository/u)
    await assert.rejects(client().getRepoHead({ repo: 'acme/app', branch: 'b\uD800' }), /branch must be a branch or tag name/u)
    assert.deepEqual(calls, [])
    // .github, .gitignore and friends are ordinary paths.
    stubGitHub(() => json({ data: { createCommitOnBranch: { commit: { oid: SHA2, url: 'u' } } } }))
    await client().createCommit({ ...base, message: 'x', additions: [{ path: '.github/workflows/ci.yml', contents: '' }, { path: '.gitignore', contents: '' }] })
  })

  it('escapes what a value was, in the message about it', async () => {
    forbidRequests()
    await assert.rejects(client().createPR({ repo: 'acme/app', title: '\u001B[2J\u202E', head: 'fix', base: 'main' }), { message: 'createPR: title must be a non-empty single line, got "\\u001b[2J\\u202e"' })
  })
})

describe('parseGraphQLResponse', () => {
  it('answers the data', () => {
    assert.deepEqual(parseGraphQLResponse(200, '{"data":{"a":1}}'), { a: 1 })
  })

  it('carries the status and the body of a transport error, as an HttpError', () => {
    assert.throws(() => parseGraphQLResponse(502, '<html>Bad Gateway</html>'), (err) => err instanceof HttpError && err.status === 502 && err.message === 'GitHub GraphQL 502: <html>Bad Gateway</html>')
    assert.throws(() => parseGraphQLResponse(401, ''), (err) => err instanceof HttpError && err.status === 401 && err.message === 'GitHub GraphQL 401: (empty body)')
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
