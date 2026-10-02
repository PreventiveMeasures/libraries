// A package.json as pnpm, yarn 1 and npm read one, a byte order mark dropped.

import { DeptreeError, quote } from './error.js'

export function readManifest(text, where) {
  if (typeof text !== 'string') throw new TypeError(`${where} must be the text of a package.json`)
  let manifest
  try {
    manifest = JSON.parse(text.replace(/^﻿/u, ''))
  } catch (error) {
    throw new DeptreeError(`not JSON: ${error.message}`, where, { cause: error })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('expected an object', where)
  return manifest
}

// The package.json texts given by directory, in a Map or a Record.
export function readManifests(texts) {
  const read = new Map()
  for (const [dir, text] of texts instanceof Map ? texts : Object.entries(texts)) read.set(dir, readManifest(text, `manifests[${quote(dir)}]`))
  if (!read.has('.')) throw new DeptreeError('the root package.json is not given', 'manifests["."]')
  return read
}
