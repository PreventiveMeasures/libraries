// Package.resolved, version 1, 2 or 3, as SwiftPM 5.0 to 6.4 write it: the
// file held to the layout of the writer of its version, TSCBasic's JSON of
// version 1 and JSONEncoder of 2 and 3, every pin to what SwiftPM writes of
// its kind, and the pins to each other, in the order SwiftPM sorts them in,
// each once. SwiftPM writes version 1 of a root package of a tools version
// below 5.6, 2 below 5.10, and 3 of the rest, with originHash.

import { LockfileError, quote } from '../error.js'
import { isHexSha256 } from '../names.js'
import { sha256Hex } from '../sha.js'
import { checkOptions, checkerOf, kind, record, required, sequence, text } from '../shape.js'
import { checkLayout, readJson } from './json.js'
import { readLegacyPin, readPin } from './pin.js'

const FIELDS = { __proto__: null, 1: ['object', 'version'], 2: ['pins', 'version'], 3: ['originHash', 'pins', 'version'] }
const EVERY = 'which SwiftPM writes in every Package.resolved'

const checkOriginHash = checkerOf(text)(isHexSha256, 'a sha256 in lowercase hex, as SwiftPM writes originHash')

function readVersion(root) {
  required(record(root), ['version'], undefined, EVERY)
  if (root.version !== 1 && root.version !== 2 && root.version !== 3) throw new LockfileError(`expected 1, 2 or 3, found ${kind(root.version)}`, 'version')
  return root.version
}

// The pins by identity, in the order SwiftPM sorts them in, as it compares
// identities, and each once, as it tells them apart: in lowercase, as
// Foundation's caseInsensitiveCompare and PackageIdentity's hash fold
// ASCII, which is all an identity here is. None, SwiftPM writes no file.
function readPins(list, where, read) {
  if (sequence(list, where).length === 0) throw new LockfileError('no pins, where SwiftPM removes the file instead', where)
  const pins = Object.create(null)
  let previous
  for (const [index, item] of list.entries()) {
    const here = `${where}[${index}]`
    const pin = read(item, here)
    const key = pin.identity.toLowerCase()
    if (previous !== undefined && key <= previous.key) {
      if (key === previous.key) throw new LockfileError(`${quote(pin.identity)} is the identity of ${where}[${index - 1}] too, as SwiftPM compares identities, without case`, here)
      throw new LockfileError(`${quote(pin.identity)} after ${quote(previous.identity)}, where SwiftPM sorts pins by identity, without case`, here)
    }
    pins[pin.identity] = pin
    previous = { key, identity: pin.identity }
  }
  return pins
}

// The manifest's bytes, as SwiftPM reads them to hash: decoded as UTF-8, a
// byte of no character as U+FFFD, and encoded again.
function manifestBytes(manifest) {
  if (manifest === undefined) return undefined
  if (manifest instanceof Uint8Array) return new TextEncoder().encode(new TextDecoder('utf-8', { ignoreBOM: true }).decode(manifest))
  if (typeof manifest !== 'string') throw new TypeError('manifest: expected the manifest as a string or a Uint8Array')
  if (!manifest.isWellFormed()) throw new TypeError('manifest: expected the manifest as well-formed text, or its bytes')
  return new TextEncoder().encode(manifest)
}

function checkManifest(bytes, originHash) {
  if (originHash === undefined) throw new LockfileError('no originHash to hold the manifest to, which SwiftPM writes in version 3 alone')
  const digest = sha256Hex(bytes)
  if (digest !== originHash) throw new LockfileError(`not the sha256 of the manifest given, ${digest}: the lockfile was written for another manifest, or of more than one`, 'originHash')
}

// The version first, which says whose layout the file is held to, then the
// fields.
export function parsePackageResolved(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const manifest = manifestBytes(checkOptions(options, ['manifest']).manifest)
  const json = readJson(source)
  const root = json.value
  const version = readVersion(root)
  checkLayout(source, json, version)
  record(root, undefined, FIELDS[version])
  let pins
  if (version === 1) {
    required(root, ['object'], undefined, 'which SwiftPM writes the pins of version 1 in')
    required(record(root.object, 'object', ['pins']), ['pins'], 'object', EVERY)
    pins = readPins(root.object.pins, 'object.pins', readLegacyPin)
  } else {
    required(root, ['pins'], undefined, EVERY)
    pins = readPins(root.pins, 'pins', readPin)
  }
  let originHash
  if (version === 3) {
    required(root, ['originHash'], undefined, 'which SwiftPM writes in every version 3')
    originHash = checkOriginHash(root.originHash, 'originHash')
  }
  if (manifest !== undefined) checkManifest(manifest, originHash)
  return { version, originHash, pins }
}
