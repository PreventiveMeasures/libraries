import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createClient } from '../github.js'
import { commitOf, packOf, uploadPackAnswer } from './git-pack.js'

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbe4904d'
const COMMIT = commitOf(TREE)
const UPLOAD_PACK = 'https://github.com/acme/app.git/git-upload-pack'

const pkt = (text) => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// github.com's git-upload-pack for acme/app, answering with `answer`.
function stub(answer, status = 200) {
  const calls = []
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url: String(url), ...options })
    if (String(url) !== UPLOAD_PACK) return Promise.resolve(new Response('Not Found', { status: 404 }))
    return Promise.resolve(new Response(answer, { status, headers: status === 301 ? { location: 'https://github.com/acme/moved.git/git-upload-pack' } : {} }))
  }
  return calls
}

describe('getCommitTree', () => {
  it("reads the tree off the commit's own object, fetched as git fetches it and held to its id", async () => {
    const calls = stub(uploadPackAnswer(packOf([{ type: 'commit', data: COMMIT.object }]), { sha: COMMIT.id, piece: 7 }))
    assert.equal(await createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id }), TREE)
    assert.equal(calls.length, 1)
    const [{ url, method, redirect, headers, body }] = calls
    assert.deepEqual([url, method, redirect], [UPLOAD_PACK, 'POST', 'manual'])
    assert.deepEqual({ ...headers, 'User-Agent': undefined }, { 'User-Agent': undefined, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' })
    assert.equal(Buffer.from(body).toString(), `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt(`want ${COMMIT.id}\n`)}${pkt('deepen 1\n')}${pkt('filter tree:0\n')}${pkt('no-progress\n')}${pkt('done\n')}0000`)
  })

  it('sends the token as git sends one, by Basic', async () => {
    const calls = stub(uploadPackAnswer(packOf([{ type: 'commit', data: COMMIT.object }])))
    await createClient({ token: 't0ken' }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id })
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('x-access-token:t0ken').toString('base64')}`)
  })

  it('finds the commit among other objects, and none but it', async () => {
    const other = commitOf(TREE, 'other\n')
    stub(uploadPackAnswer(packOf([{ type: 'blob', data: Buffer.from('x') }, { type: 'commit', data: other.object }, { type: 'commit', data: COMMIT.object }])))
    assert.equal(await createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id }), TREE)
    stub(uploadPackAnswer(packOf([{ type: 'commit', data: other.object }])))
    await assert.rejects(createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id }), new RegExp(`getCommitTree: GitHub's packfile holds no commit ${COMMIT.id}`, 'u'))
  })

  it('refuses an answer but a sound pack of the commit', async () => {
    const pack = packOf([{ type: 'commit', data: COMMIT.object }])
    const broken = Buffer.from(pack)
    broken[broken.length - 1] ^= 1
    for (const [answer, message] of [
      [Buffer.from(pkt('ERR not our ref\n')), /GitHub refused the fetch: not our ref/u],
      [Buffer.from(`${pkt('packfile\n')}${pkt('\u0003fatal: no\n')}0000`), /GitHub refused the fetch: fatal: no/u],
      [Buffer.from(`${pkt('shallow-info\n')}0000`), /GitHub answered with no packfile/u],
      [uploadPackAnswer(broken), /GitHub's packfile does not match its trailer/u],
      [uploadPackAnswer(Buffer.from('not a pack at all, not at all')), /GitHub's packfile is no packfile/u],
      [Buffer.from('<html>'), /GitHub's answer is not git's packet lines/u],
      [uploadPackAnswer(packOf([{ type: 'commit', data: Buffer.from('author x\n') }]).subarray(0)), /holds no commit/u],
    ]) {
      stub(answer)
      await assert.rejects(createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id }), message, String(message))
    }
    const notree = Buffer.from('parent 0000000000000000000000000000000000000000\n\nx\n')
    const { createHash } = await import('node:crypto')
    const id = createHash('sha1').update(`commit ${notree.length}\0`).update(notree).digest('hex')
    stub(uploadPackAnswer(packOf([{ type: 'commit', data: notree }])))
    await assert.rejects(createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: id }), /names no tree first, as git writes one/u)
  })

  it("throws GitHub's redirect for a repository renamed, rather than follow it, and refuses a sha256 or a bad repo before any request", async () => {
    stub('', 301)
    await assert.rejects(createClient({ token: null }).getCommitTree({ repo: 'acme/app', sha: COMMIT.id }), { name: 'HttpError', status: 301 })
    for (const options of [{ repo: 'acme/app', sha: 'a'.repeat(64) }, { repo: 'acme/app', sha: COMMIT.id.toUpperCase() }, { repo: 'acme', sha: COMMIT.id }, { repo: 'acme/app' }]) {
      const calls = stub('')
      await assert.rejects(createClient({ token: null }).getCommitTree(options), /getCommitTree: (?:repo|sha) must be/u, JSON.stringify(options))
      assert.deepEqual(calls, [])
    }
  })
})
