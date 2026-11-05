// A commit as git writes one, a packfile of objects, and github.com's
// git-upload-pack answer carrying one, as the protocol v2 fetch reads them.

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 }

// A commit of `tree`, its id and its object's bytes.
export function commitOf(tree, message = 'acme\n') {
  const object = Buffer.from(`tree ${tree}\nauthor Acme <acme@example.com> 0 +0000\ncommitter Acme <acme@example.com> 0 +0000\n\n${message}`)
  return { id: createHash('sha1').update(`commit ${object.length}\0`).update(object).digest('hex'), object }
}

export function packOf(objects) {
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)]
  parts[2].writeUInt32BE(objects.length)
  for (const { type, data } of objects) {
    const header = []
    let size = data.length
    let byte = (TYPES[type] << 4) | (size & 15)
    size = Math.floor(size / 16)
    while (size > 0) {
      header.push(byte | 0x80)
      byte = size & 0x7f
      size = Math.floor(size / 128)
    }
    header.push(byte)
    parts.push(Buffer.from(header), deflateSync(data))
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}

const pkt = (data) => Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), Buffer.from(data)])

// As GitHub answers a fetch with `deepen 1`: shallow-info, then the pack on
// side-band 1, a progress line on 2 among it, cut into pieces of `piece`.
export function uploadPackAnswer(pack, { sha = '0'.repeat(40), piece = 65515 } = {}) {
  const pieces = []
  for (let at = 0; at < pack.length; at += piece) pieces.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + piece)])))
  return Buffer.concat([pkt('shallow-info\n'), pkt(`shallow ${sha}\n`), Buffer.from('0001'), pkt('packfile\n'), pkt('\u0002Enumerating objects: 1, done.\n'), ...pieces, Buffer.from('0000')])
}
