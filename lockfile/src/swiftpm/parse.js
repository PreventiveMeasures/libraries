// Package.resolved, version 1, 2 or 3, as SwiftPM 5.0 to 6.4 write it: the
// file held to the layout of the writer of its version, TSCBasic's JSON of
// version 1 and JSONEncoder of 2 and 3, every pin to what SwiftPM writes of
// its kind, and the pins to each other, in the order SwiftPM sorts them in,
// each once. SwiftPM writes version 1 of a root package of a tools version
// below 5.6, 2 below 5.10, and 3 of the rest, with originHash.

import { LockfileError, at, quote } from '../error.js'
import { isHexSha256 } from '../names.js'
import { checkOptions, checkerOf, kind, record, sequence, text } from '../shape.js'
import { sha256Hex } from '../sha256.js'
import { readJson } from './json.js'
import { sortKey } from './location.js'
import { readLegacyPin, readPin } from './pin.js'

const COLON = { __proto__: null, 1: ': ', 2: ' : ', 3: ' : ' }
const WRITER = { __proto__: null, 1: 'TSCBasic\'s JSON', 2: 'JSONEncoder', 3: 'JSONEncoder' }
const FIELDS = { __proto__: null, 1: ['object', 'version'], 2: ['pins', 'version'], 3: ['originHash', 'pins', 'version'] }

const checkOriginHash = checkerOf(text)(isHexSha256, 'a sha256 in lowercase hex, as SwiftPM writes originHash')

function readVersion(root, colon) {
  const { version } = record(root)
  if (version === undefined) throw new LockfileError('expected version, which SwiftPM writes in every Package.resolved')
  if (version !== 1 && version !== 2 && version !== 3) throw new LockfileError(`expected 1, 2 or 3, found ${kind(version)}`, 'version')
  if (COLON[version] !== colon) throw new LockfileError(`version ${version} is written by ${WRITER[version]}, with ${quote(COLON[version])} after a key, not ${quote(colon)}`, 'version')
  return version
}

// The pins by identity, in the order SwiftPM sorts them, as it compares
// identities: without case, as it tells them apart.
function readPins(list, where, read) {
  const pins = Object.create(null)
  let last
  for (const [index, item] of sequence(list, where).entries()) {
    const here = `${where}[${index}]`
    const pin = read(item, here)
    const key = sortKey(pin.identity)
    if (last !== undefined && key <= last.key) {
      if (key === last.key) throw new LockfileError(`${quote(pin.identity)} is the identity of ${last.where} too, as SwiftPM compares identities, without case`, here)
      throw new LockfileError(`${quote(pin.identity)} after ${quote(last.identity)}, where SwiftPM sorts pins by identity, without case`, here)
    }
    pins[pin.identity] = pin
    last = { key, identity: pin.identity, where: here }
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

export function parsePackageResolved(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const manifest = manifestBytes(checkOptions(options, ['manifest']).manifest)
  const { root, colon } = readJson(source)
  const version = readVersion(root, colon)
  record(root, undefined, FIELDS[version])
  let pins
  if (version === 1) {
    if (root.object === undefined) throw new LockfileError('expected object, which SwiftPM writes the pins of version 1 in')
    const object = record(root.object, 'object', ['pins'])
    if (object.pins === undefined) throw new LockfileError('expected pins, which SwiftPM writes in every Package.resolved', 'object')
    pins = readPins(object.pins, at('object', 'pins'), readLegacyPin)
  } else {
    if (root.pins === undefined) throw new LockfileError('expected pins, which SwiftPM writes in every Package.resolved')
    pins = readPins(root.pins, 'pins', readPin)
  }
  if (version === 3 && root.originHash === undefined) throw new LockfileError('expected originHash, which SwiftPM writes in every version 3')
  const originHash = version === 3 ? checkOriginHash(root.originHash, 'originHash') : undefined
  if (manifest !== undefined) checkManifest(manifest, originHash)
  return { version, originHash, pins }
}
