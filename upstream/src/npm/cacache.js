import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readRegularFile } from '../cache.js'

// npm's cache, cacache as npm 5 and later keep it: a response by the URL
// it answered, under the key `make-fetch-happen:request-cache:<url>`. The
// index has a file for each key's sha256, of lines `<sha1>\t<entry>`, each
// entry's sha1 of its own JSON: the last whole one for the key counts, and
// one with no integrity is one deleted. The content is filed by its
// sha512, and checked against it.
const KEY = 'make-fetch-happen:request-cache:'
const digest = (algorithm, data, encoding) => createHash(algorithm).update(data).digest(encoding)
const shard = (hex) => [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)]
const decoder = new TextDecoder('utf-8')

async function lastEntry(root, key) {
  const bytes = await readRegularFile(join(root, 'index-v5', ...shard(digest('sha256', key, 'hex'))))
  let entry = null
  for (const line of bytes ? decoder.decode(bytes).split('\n') : []) {
    const tab = line.indexOf('\t')
    const json = line.slice(tab + 1)
    if (tab < 0 || digest('sha1', json, 'hex') !== line.slice(0, tab)) continue
    try {
      const parsed = JSON.parse(json)
      if (parsed?.key === key) entry = parsed
    } catch {
      // A line cut short, or written over: passed over, as npm passes it.
    }
  }
  return entry
}

// The body npm keeps for `url`, beside what it kept of the response, or
// null: none kept, one deleted, or content gone or not its sha512.
export async function readNpmCached(root, url) {
  const entry = await lastEntry(root, `${KEY}${url}`)
  const integrity = typeof entry?.integrity === 'string' ? entry.integrity : ''
  const sha512 = /(?:^|\s)sha512-([\d+/A-Za-z]+={0,2})(?=[\s?]|$)/u.exec(integrity)?.[1]
  if (sha512 === undefined) return null
  const body = await readRegularFile(join(root, 'content-v2', 'sha512', ...shard(Buffer.from(sha512, 'base64').toString('hex'))))
  return body && digest('sha512', body, 'base64') === sha512 ? { body, metadata: entry.metadata } : null
}
