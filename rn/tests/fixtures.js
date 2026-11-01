import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { createVfs } from '@preventive/vfs'

// A tree maps paths to files -- text, bytes, or an object written as JSON --
// and to { link }, a symlink to that target.
const isLink = (content) => content !== null && typeof content === 'object' && 'link' in content
const dataOf = (content) => (typeof content === 'string' || content instanceof Uint8Array ? content : JSON.stringify(content))

// The tree on disk under a fresh directory, by its real path. -> { root, cleanup }
export function writeTree(tree) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-test-')))
  for (const [rel, content] of Object.entries(tree)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    if (isLink(content)) symlinkSync(content.link, path)
    else writeFileSync(path, dataOf(content))
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// The tree as a Vfs holds it, from `/`.
export const vfsOf = (tree) => createVfs(Object.fromEntries(Object.entries(tree).map(([rel, content]) => [rel, isLink(content) ? { type: 'symlink', target: content.link } : dataOf(content)])))

// A tree's files under node_modules/<name>.
export const pkg = (name, files) => Object.fromEntries(Object.entries(files).map(([rel, content]) => [`node_modules/${name}/${rel}`, content]))

// A resolution with its paths from `root`, posix: `<empty>`, a path, or the
// paths of an asset's files joined by `,`; null for none.
export function shown(root, resolution) {
  if (resolution == null) return null
  const rel = (path) => relative(root, path).split(sep).join('/')
  if (resolution.type === 'empty') return '<empty>'
  if (resolution.type === 'sourceFile') return rel(resolution.filePath)
  if (resolution.type === 'assetFiles') return resolution.filePaths.map(rel).join(',')
  return `<${resolution.type}>`
}

// A PNG's first bytes, enough for its size.
export const png = (width, height) => {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
