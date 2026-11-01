// What the resolver and the asset readers read a tree through: the disk by
// default, or anything with the same five synchronous calls. A Vfs from
// @preventive/vfs has them as they are. Paths are absolute, as node:path
// spells them; a file and a directory are what a link leads to.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'

const kind = (path) => {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null // ENOTDIR, ELOOP, EACCES: nothing there to resolve to
  }
}

export const diskHost = Object.freeze({
  isFile: (path) => kind(path)?.isFile() ?? false,
  isDirectory: (path) => kind(path)?.isDirectory() ?? false,
  realpath: (path) => realpathSync(path),
  readFile: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path),
})

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The manifest at `file`, parsed, through `host`. One that is there but is no
// JSON object fails the resolution rather than being passed by, as Metro's
// package cache throws on it.
export function readManifest(host, file) {
  let manifest
  try {
    manifest = JSON.parse(decoder.decode(host.readFile(file)))
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`Invalid package.json: ${file}: not an object`)
  return manifest
}
