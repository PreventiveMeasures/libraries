// A commit's tree, held to the commit's id: the commit object itself, as
// git fetches it from github.com over its protocol v2, and hashed, where
// the API's answer for a commit is GitHub's word for what is in it.

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

import { assertArgs, assertRepo, assertion, isSha1, printable, show } from '../args.js'
import { GITHUB_WEB, buildUrl, request } from '../http.js'

// A commit object is a few KiB; one past this is refused rather than read.
const MAX_OBJECT = 1024 * 1024

const ascii = (text) => Buffer.from(text, 'latin1')
const pkt = (text) => {
  const data = ascii(text)
  return Buffer.concat([ascii((data.length + 4).toString(16).padStart(4, '0')), data])
}
const DELIM = ascii('0001')
const FLUSH = ascii('0000')

// `git fetch --depth 1 --filter=tree:0 origin <sha>`, as protocol v2 asks
// it: the commit alone, none of its trees, blobs or parents.
const fetchRequest = (sha) => Buffer.concat([
  pkt('command=fetch\n'), pkt('object-format=sha1\n'), DELIM,
  pkt(`want ${sha}\n`), pkt('deepen 1\n'), pkt('filter tree:0\n'), pkt('no-progress\n'), pkt('done\n'), FLUSH,
])

// The response's packet lines, each its data or, for a flush, a delimiter
// or a response end, null.
function* packets(bytes, method) {
  let at = 0
  while (at < bytes.length) {
    const head = bytes.subarray(at, at + 4).toString('latin1')
    assert.ok(/^[\da-f]{4}$/u.test(head), `${method}: GitHub's answer is not git's packet lines`)
    const length = Number.parseInt(head, 16)
    if (length < 4) {
      at += 4
      yield null
      continue
    }
    assert.ok(at + length <= bytes.length, `${method}: GitHub's answer ends inside a packet`)
    yield bytes.subarray(at + 4, at + length)
    at += length
  }
}

// The packfile section's bytes, side-band 1 of each of its packets, to the
// flush that ends it. Before it, shallow-info and the like are passed over;
// git's ERR, or side-band 3, refuses.
function packOf(bytes, method) {
  const chunks = []
  let inPack = false
  for (const data of packets(bytes, method)) {
    if (!inPack) {
      const text = data === null ? '' : data.toString('latin1').replace(/\n$/u, '')
      assert.ok(!text.startsWith('ERR '), `${method}: GitHub refused the fetch: ${printable(text.slice(4))}`)
      inPack = text === 'packfile'
      continue
    }
    if (data === null) return Buffer.concat(chunks)
    assert.ok(data[0] !== 3, `${method}: GitHub refused the fetch: ${printable(data.subarray(1).toString('latin1'))}`)
    if (data[0] === 1) chunks.push(data.subarray(1))
  }
  assert.fail(`${method}: GitHub answered with no packfile`)
}

// The bytes of the commit `sha` in the pack, an object of the commit type
// whose `commit <size>\0` and bytes hash to it. The pack is held to its
// trailer, the sha1 of the rest; an object is read a zlib stream at a time.
function commitIn(pack, sha, method) {
  assert.ok(pack.length >= 32 && pack.toString('latin1', 0, 4) === 'PACK' && [2, 3].includes(pack.readUInt32BE(4)), `${method}: GitHub's packfile is no packfile`)
  const end = pack.length - 20
  assert.ok(createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end)), `${method}: GitHub's packfile does not match its trailer`)
  let at = 12
  for (let count = pack.readUInt32BE(8); count > 0; count--) {
    let byte = pack[at++]
    const type = (byte >> 4) & 7
    let size = byte & 15
    for (let shift = 4; byte & 0x80; shift += 7) {
      byte = pack[at++]
      size += (byte & 0x7f) * 2 ** shift
    }
    assert.ok(at <= end && size <= MAX_OBJECT, `${method}: an object in GitHub's packfile is cut short, or larger than ${MAX_OBJECT} bytes`)
    // A delta names its base by an offset, or by its id.
    if (type === 6) {
      while (pack[at] & 0x80) at++
      at++
    }
    if (type === 7) at += 20
    let object
    try {
      object = inflateSync(pack.subarray(at, end), { info: true, maxOutputLength: Math.max(size, 1) })
    } catch (cause) {
      throw new Error(`${method}: an object in GitHub's packfile does not inflate`, { cause })
    }
    at += object.engine.bytesWritten
    if (type !== 1 || object.buffer.length !== size) continue
    const id = createHash('sha1').update(`commit ${size}\0`).update(object.buffer).digest('hex')
    if (id === sha) return object.buffer
  }
  assert.fail(`${method}: GitHub's packfile holds no commit ${sha}`)
}

// A sha1 alone: GitHub keeps no repository in sha256.
const assertCommit = assertion('a full commit sha1', isSha1)

// The id of the tree of the full commit `sha`, from the commit's own
// object: fetched from github.com's git-upload-pack, as git fetches it, and
// held to `sha`, so the tree is the commit's whatever GitHub's API says.
// The API's token, where the client has one, is sent as git sends one, by
// Basic. A redirect is not followed: one for a repository renamed or
// transferred throws, as getRepo is the call that follows it.
export async function getCommitTree(headers, options) {
  assertArgs('getCommitTree', options, { repo: assertRepo, sha: assertCommit })
  const { repo, sha } = options
  const [owner, name] = repo.split('/')
  const token = /^Bearer (.+)$/u.exec(headers.Authorization ?? '')?.[1]
  const answer = await request(buildUrl(GITHUB_WEB, [owner, `${name}.git`, 'git-upload-pack']), {
    method: 'POST',
    as: 'bytes',
    headers: {
      ...(token !== undefined && { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }),
      'User-Agent': headers['User-Agent'],
      'Git-Protocol': 'version=2',
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
    },
    body: fetchRequest(sha),
  })
  const commit = commitIn(packOf(Buffer.from(answer), 'getCommitTree'), sha, 'getCommitTree')
  const tree = /^tree ([\da-f]{40})\n/u.exec(commit.toString('latin1'))?.[1]
  assert.ok(tree !== undefined, `getCommitTree: the commit ${sha} in ${repo} names no tree first, as git writes one: ${show(commit.toString('latin1', 0, 60))}`)
  return tree
}
