import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'

import { HttpError, createClient } from '../github.js'
import { SHA, SHA2, forbidRequests, json, stubGitHub } from './github-stub.js'

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
      'getRepoFile', 'getRepoHead', 'getRepoTag', 'getRepoTarball', 'getRepoTreeId', 'getRepoTreeTarball', 'listRepoAdvisories', 'listRepoDir', 'listRepoTags', 'listUserRepos',
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

describe('getRepoTag', () => {
  const API = 'https://api.github.com/repos/acme/app'
  const TAG_OBJECT = 'a'.repeat(40)
  const ref = (tag, object) => ({ ref: `refs/tags/${tag}`, object })
  // GitHub, for acme/app: `refs` by tag name, `tags` (annotated tag objects) by sha.
  const stub = ({ refs = {}, tags = {} }) => stubGitHub(({ url }) => {
    const path = decodeURIComponent(url.slice(API.length + 1))
    if (path.startsWith('git/ref/tags/') && Object.hasOwn(refs, path.slice(13))) return json(refs[path.slice(13)])
    if (path.startsWith('git/tags/') && Object.hasOwn(tags, path.slice(9))) return json(tags[path.slice(9)])
    return json({ message: 'Not Found' }, 404)
  })

  it("finds a lightweight tag's commit from its ref alone, a slash in its name encoded", async () => {
    const calls = stub({ refs: { 'release/v1': ref('release/v1', { type: 'commit', sha: SHA }) } })
    assert.deepEqual(await client().getRepoTag({ repo: 'acme/app', tag: 'release/v1' }), { tag: 'release/v1', oid: SHA })
    assert.deepEqual(calls.map((c) => c.url), [`${API}/git/ref/tags/release%2Fv1`])
  })

  it("follows an annotated tag's object to the commit, through a tag of a tag", async () => {
    let calls = stub({ refs: { v1: ref('v1', { type: 'tag', sha: TAG_OBJECT }) }, tags: { [TAG_OBJECT]: { sha: TAG_OBJECT, tag: 'v1', object: { type: 'commit', sha: SHA } } } })
    assert.deepEqual(await client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), { tag: 'v1', oid: SHA })
    assert.deepEqual(calls.map((c) => c.url), [`${API}/git/ref/tags/v1`, `${API}/git/tags/${TAG_OBJECT}`])
    calls = stub({ refs: { v1: ref('v1', { type: 'tag', sha: SHA2 }) }, tags: { [SHA2]: { sha: SHA2, object: { type: 'tag', sha: TAG_OBJECT } }, [TAG_OBJECT]: { sha: TAG_OBJECT, object: { type: 'commit', sha: SHA } } } })
    assert.deepEqual(await client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), { tag: 'v1', oid: SHA })
    assert.equal(calls.length, 3)
  })

  it('refuses a tag on a tree or a blob, or one GitHub names no commit for', async () => {
    for (const object of [{ type: 'tree', sha: SHA }, { type: 'blob', sha: SHA }, { type: 'commit', sha: 'main' }, { type: 'tag' }, null]) {
      stub({ refs: { v1: ref('v1', object) } })
      await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), /getRepoTag: acme\/app has no commit for tag "v1"$/u, JSON.stringify(object))
    }
    stub({ refs: { v1: ref('v1', { type: 'tag', sha: TAG_OBJECT }) }, tags: { [TAG_OBJECT]: { sha: TAG_OBJECT, object: { type: 'tree', sha: SHA } } } })
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), /has no commit for tag "v1"$/u)
  })

  it('refuses an answer for another ref or another tag object, and tags of tags without end', async () => {
    for (const answer of [ref('v1.0', { type: 'commit', sha: SHA }), { ...ref('v1', { type: 'commit', sha: SHA }), ref: 'refs/heads/v1' }, [ref('v1', { type: 'commit', sha: SHA })]]) {
      stub({ refs: { v1: answer } })
      await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), /getRepoTag: GitHub answered for .*, not "refs\/tags\/v1"$/u, JSON.stringify(answer))
    }
    stub({ refs: { v1: ref('v1', { type: 'tag', sha: TAG_OBJECT }) }, tags: { [TAG_OBJECT]: { sha: SHA2, object: { type: 'commit', sha: SHA } } } })
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), new RegExp(`getRepoTag: GitHub answered for another tag object than ${TAG_OBJECT}$`, 'u'))
    const calls = stub({ refs: { v1: ref('v1', { type: 'tag', sha: TAG_OBJECT }) }, tags: { [TAG_OBJECT]: { sha: TAG_OBJECT, object: { type: 'tag', sha: TAG_OBJECT } } } })
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), /has no commit for tag "v1"$/u)
    assert.equal(calls.length, 9)
  })

  it("takes a tag's name as git does, `@` and a leading `-` included, unlike a branch's", async () => {
    const calls = stub({ refs: { '@': ref('@', { type: 'commit', sha: SHA }), '-v1': ref('-v1', { type: 'commit', sha: SHA2 }) } })
    assert.deepEqual(await client().getRepoTag({ repo: 'acme/app', tag: '@' }), { tag: '@', oid: SHA })
    assert.deepEqual(await client().getRepoTag({ repo: 'acme/app', tag: '-v1' }), { tag: '-v1', oid: SHA2 })
    assert.deepEqual(calls.map((c) => c.url), [`${API}/git/ref/tags/%40`, `${API}/git/ref/tags/-v1`])
  })

  it('escapes the tag it names in an error', async () => {
    stub({ refs: { 'v1\u202Eevil': ref('v2', { type: 'commit', sha: SHA }) } })
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1\u202Eevil' }), (err) => !err.message.includes('\u202E') && err.message.endsWith('not "refs/tags/v1\\u202eevil"'))
  })

  it('takes only a tag name git would take, before any request, and throws a HttpError for a tag GitHub does not have', async () => {
    const calls = forbidRequests()
    for (const tag of [undefined, '', 'v1..2', 'v1^', 'refs/tags/', 'v1.lock', 'a b', 'v1@{0}', '.v1', 'v1/']) {
      await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag }), /getRepoTag: tag must be a tag name/u, String(tag))
    }
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1', sha: SHA }), /getRepoTag: unknown option sha/u)
    assert.deepEqual(calls, [])
    stub({})
    await assert.rejects(client().getRepoTag({ repo: 'acme/app', tag: 'v1' }), { name: 'HttpError', status: 404, message: `GET ${API}/git/ref/tags/v1 404: {"message":"Not Found"}` })
  })
})

describe('listRepoTags', () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ name: `v${n}.${i}`, commit: { sha: SHA, url: 'https://api.github.com/repos/acme/app/commits/x' }, zipball_url: 'z', tarball_url: 't', node_id: 'n' }))

  it('reads every page, until a short one, each tag with its commit alone', async () => {
    const calls = stubGitHub(({ url }) => json(url.endsWith('page=1') ? page(1, 100) : page(2, 3)))
    const tags = await client().listRepoTags({ repo: 'acme/app' })
    assert.equal(tags.length, 103)
    assert.deepEqual(tags[0], { tag: 'v1.0', oid: SHA })
    assert.deepEqual(tags.at(-1), { tag: 'v2.2', oid: SHA })
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.github.com/repos/acme/app/tags?per_page=100&page=1',
      'https://api.github.com/repos/acme/app/tags?per_page=100&page=2',
    ])
  })

  it('stops at maxPages, and refuses a page that is no list', async () => {
    const calls = stubGitHub(() => json(page(1, 100)))
    await assert.rejects(client().listRepoTags({ repo: 'acme/app', maxPages: 2 }), /listRepoTags: more than 2 pages/u)
    assert.equal(calls.length, 3)
    stubGitHub(() => json({ message: 'odd' }))
    await assert.rejects(client().listRepoTags({ repo: 'acme/app' }), /listRepoTags: expected an array for page 1/u)
  })

  it('refuses a tag listed with no name git would take, or no commit', async () => {
    for (const change of [{ name: undefined }, { name: 'v1..2' }, { commit: null }, { commit: { sha: 'main' } }]) {
      stubGitHub(() => json([{ ...page(1, 1)[0], ...change }]))
      await assert.rejects(client().listRepoTags({ repo: 'acme/app' }), /listRepoTags: GitHub listed .* in acme\/app, which is no tag name with a commit$/u, JSON.stringify(change))
    }
    stubGitHub(() => json([{ ...page(1, 1)[0], name: 'v1..2' }]))
    await assert.rejects(client().listRepoTags({ repo: 'acme/app' }), /GitHub listed "v1\.\.2" in acme\/app/u)
  })

  it('lists a tag named `@` or with a leading `-`, as git allows', async () => {
    stubGitHub(() => json([{ ...page(1, 1)[0], name: '@' }, { ...page(1, 1)[0], name: '-v1' }]))
    assert.deepEqual((await client().listRepoTags({ repo: 'acme/app' })).map(({ tag }) => tag), ['@', '-v1'])
  })

  it('reads every page for the repo it was asked for, whatever the options object says later', async () => {
    const options = { repo: 'acme/app' }
    const calls = stubGitHub(({ url }) => {
      options.repo = 'other/thing'
      return json(url.endsWith('page=1') ? page(1, 100) : page(2, 1))
    })
    assert.equal((await client().listRepoTags(options)).length, 101)
    assert.ok(calls.every(({ url }) => url.startsWith('https://api.github.com/repos/acme/app/tags?')), calls.map(({ url }) => url).join())
  })

  it('takes a repo and maxPages only, before any request', async () => {
    const calls = forbidRequests()
    await assert.rejects(client().listRepoTags({ repo: 'acme' }), /listRepoTags: repo must be "owner\/name"/u)
    await assert.rejects(client().listRepoTags({ repo: 'acme/app', maxPages: 0 }), /listRepoTags: maxPages must be a positive integer/u)
    await assert.rejects(client().listRepoTags({ repo: 'acme/app', page: 2 }), /listRepoTags: unknown option page/u)
    await assert.rejects(client().listRepoTags(), /listRepoTags: options must be an options object/u)
    assert.deepEqual(calls, [])
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

describe('listRepoAdvisories', () => {
  const LIST = 'https://api.github.com/repos/acme/app/security-advisories?state=published&per_page=100'
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ ghsa_id: `GHSA-${n}`, i }))
  // GitHub's links name the repository by its id, and other parameters
  // besides the cursor.
  const linked = (body, next) => new Response(JSON.stringify(body), { headers: { link: `<https://api.github.com/repositories/1/security-advisories?per_page=100&state=published&before=x&after=${next}>; rel="next", <https://api.github.com/repositories/1/security-advisories?per_page=100&state=published&after=Zmlyc3Q>; rel="first"` } })

  it("reads every page, each by the cursor in the one before's Link header, asked of this repository's list", async () => {
    const calls = stubGitHub(({ url }) => {
      if (url === LIST) return linked(page(1, 100), 'Y3Vyc29yOjE%3D')
      if (url === `${LIST}&after=Y3Vyc29yOjE%3D`) return linked(page(2, 100), 'Y3Vyc29yOjI%3D')
      return json(page(3, 2))
    })
    const list = await client().listRepoAdvisories({ repo: 'acme/app' })
    assert.equal(list.length, 202)
    assert.deepEqual([list[0], list.at(-1)], [{ ghsa_id: 'GHSA-1', i: 0 }, { ghsa_id: 'GHSA-3', i: 1 }])
    assert.deepEqual(calls.map((call) => call.url), [LIST, `${LIST}&after=Y3Vyc29yOjE%3D`, `${LIST}&after=Y3Vyc29yOjI%3D`])
  })

  it('reads one page when there is no next link, however full', async () => {
    const calls = stubGitHub(() => json(page(1, 100)))
    assert.equal((await client().listRepoAdvisories({ repo: 'acme/app' })).length, 100)
    assert.equal(calls.length, 1)
  })

  it('refuses a next link with no cursor, a page that is no list, and more than 100 pages', async () => {
    stubGitHub(() => new Response('[]', { headers: { link: '<https://api.github.com/repositories/1/security-advisories?page=2>; rel="next"' } }))
    await assert.rejects(client().listRepoAdvisories({ repo: 'acme/app' }), /listRepoAdvisories: page 1 of acme\/app links the next with no cursor/u)
    stubGitHub(() => json({ message: 'odd' }))
    await assert.rejects(client().listRepoAdvisories({ repo: 'acme/app' }), /listRepoAdvisories: expected an array for acme\/app, page 1/u)
    const calls = stubGitHub(() => linked([], 'more'))
    await assert.rejects(client().listRepoAdvisories({ repo: 'acme/app' }), /listRepoAdvisories: acme\/app has more than 100 pages/u)
    assert.equal(calls.length, 100)
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
