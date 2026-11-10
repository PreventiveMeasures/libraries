import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// A tree maps paths to files -- text, bytes, or an object written as JSON --
// and to { link }, a symlink to that target.
const isLink = (content) => content !== null && typeof content === 'object' && 'link' in content
const dataOf = (content) => (typeof content === 'string' || content instanceof Uint8Array ? content : JSON.stringify(content))

// -> { root, cleanup }, `root` a real path.
export function writeTree(tree) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-serve-test-')))
  for (const [rel, content] of Object.entries(tree)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    if (isLink(content)) symlinkSync(content.link, path)
    else writeFileSync(path, dataOf(content))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// A PNG's first bytes, enough for its size.
export const png = (width, height) => {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

// The records of a pack's segment (load-pack.js's), its frames unpacked,
// each [key, its JSON], of those whole.
export function packedRecords(buffer) {
  const records = []
  for (let at = 0; at + 8 <= buffer.length; at += 8 + buffer.readUInt32LE(at)) {
    const frame = zstdDecompressSync(buffer.subarray(at + 8, at + 8 + buffer.readUInt32LE(at)))
    for (let start = 0; start + 68 <= frame.length; start += 68 + frame.readUInt32LE(start + 64)) records.push([frame.toString('latin1', start, start + 64), frame.toString('utf8', start + 68, start + 68 + frame.readUInt32LE(start + 64))])
  }
  return records
}
