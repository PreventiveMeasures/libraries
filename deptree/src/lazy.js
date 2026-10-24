// What a lazy tree (pnpm's and npm's) shares: its unpack, which writes each
// package asked for once, into the tree as laid out, as the full tree has it.

import { settled } from './concurrent.js'
import { quote } from './error.js'
import { mount } from './mount.js'

// `byPath` holds each package by its path from the tree's root, as
// `installed` lists it; `unpackOne` writes one and gives back its entry. One
// asked for again, or while it is unpacked, is unpacked once; one refused is
// refused again, as nothing of it was written.
export function unpacker(byPath, unpackOne) {
  const unpacking = new Map()
  return async function unpack(paths) {
    if (typeof paths === 'string' || typeof paths?.[Symbol.iterator] !== 'function') throw new TypeError('paths must be an iterable of the paths of packages the tree installs')
    const asked = [...paths]
    for (const path of asked) {
      if (typeof path !== 'string' || !byPath.has(path)) throw new TypeError(`${quote(String(path))} is not the path of a package the tree installs`)
    }
    for (const path of asked) if (!unpacking.has(path)) unpacking.set(path, unpackOne(byPath.get(path)))
    return await settled(asked.map((path) => unpacking.get(path)))
  }
}

// `tree`, a new Vfs holding one package's files at its place alone, merged
// into `vfs`, where its directory is and is empty: judged whole first, two
// names that are one on macOS among them, so a refusal writes none of it.
export const writeInto = (vfs, tree, folded) => mount(tree, vfs, folded, () => {})
