// A package.json as pnpm, yarn 1 and npm read one, a byte order mark dropped.

import { DeptreeError } from './error.js'

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
