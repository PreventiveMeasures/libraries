// The --diff of `bin/deptree.js compare`: a file both sides have with other
// bytes, as a unified diff from the disk to the tree, labelled as git labels
// one, so that `patch -p1` in the project's directory would turn the one
// into the other; or, where either is no text, the line diff prints for
// that. Not part of the published package.

import { diff } from '@preventive/diff'

// Text is UTF-8 with no NUL in it, as diff takes a NUL for a binary file's.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function textOf(bytes) {
  if (bytes.includes(0)) return undefined
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export function patchOf(path, disk, tree) {
  const [a, b] = [textOf(disk), textOf(tree)]
  if (a === undefined || b === undefined) return `Binary files a/${path} and b/${path} differ\n`
  return `--- a/${path}\n+++ b/${path}\n${diff(a, b, { format: 'unified' })}`
}
