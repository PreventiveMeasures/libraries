// Package.resolved: SwiftPM writes version 1 of a root package of tools
// version below 5.6, 2 below 5.10, and 3, with originHash, of the rest.

import { toHex } from '@exodus/bytes/hex.js'
import { LockfileError, quote } from '../error.js'
import { isHexSha256 } from '../names.js'
import { checkOptions, checkerOf, kind, record, sequence, text } from '../shape.js'
import { checkLayout, readJson } from './json.js'
import { readLegacyPin, readPin } from './pin.js'

const FIELDS = { __proto__: null, 1: ['object', 'version'], 2: ['pins', 'version'], 3: ['originHash', 'pins', 'version'] }

const checkOriginHash = checkerOf(text)(isHexSha256, 'a sha256 in lowercase hex, as SwiftPM writes originHash')

// By identity, sorted and told apart as SwiftPM does, ignoring ASCII case.
function readPins(list, where, read) {
  if (sequence(list, where).length === 0) throw new LockfileError('no pins, where SwiftPM removes the file instead', where)
  const pins = Object.create(null)
  let previous
  for (const [index, item] of list.entries()) {
    const here = `${where}[${index}]`
    const pin = read(item, here)
    const key = pin.identity.toLowerCase()
    if (key === previous?.key) throw new LockfileError(`${quote(pin.identity)} is the identity of ${where}[${index - 1}] too, as SwiftPM compares identities, without case`, here)
    if (key < previous?.key) throw new LockfileError(`${quote(pin.identity)} after ${quote(previous.identity)}, where SwiftPM sorts pins by identity, without case`, here)
    pins[pin.identity] = pin
    previous = { key, identity: pin.identity }
  }
  return pins
}

// As SwiftPM hashes it: decoded as UTF-8, a byte of no character as U+FFFD.
function manifestBytes(manifest) {
  if (manifest === undefined) return undefined
  if (manifest instanceof Uint8Array) return new TextEncoder().encode(new TextDecoder('utf-8', { ignoreBOM: true }).decode(manifest))
  if (typeof manifest !== 'string') throw new TypeError('manifest: expected the manifest as a string or a Uint8Array')
  if (!manifest.isWellFormed()) throw new TypeError('manifest: expected the manifest as well-formed text, or its bytes')
  return new TextEncoder().encode(manifest)
}

export async function parsePackageResolved(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const manifest = manifestBytes(checkOptions(options, ['manifest']).manifest)
  const json = readJson(source)
  const { version } = record(json.value)
  if (![1, 2, 3].includes(version)) throw new LockfileError(`expected 1, 2 or 3, found ${kind(version)}`, 'version')
  checkLayout(source, json, version)
  const root = record(json.value, undefined, FIELDS[version])
  const pins = version === 1 ? readPins(record(root.object, 'object', ['pins']).pins, 'object.pins', readLegacyPin) : readPins(root.pins, 'pins', readPin)
  const originHash = version === 3 ? checkOriginHash(root.originHash, 'originHash') : undefined
  if (manifest !== undefined) {
    if (originHash === undefined) throw new LockfileError('no originHash to hold the manifest to, which SwiftPM writes in version 3 alone')
    const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', manifest)))
    if (digest !== originHash) throw new LockfileError(`not the sha256 of the manifest given, ${digest}: the lockfile was written for another manifest, or of more than one`, 'originHash')
  }
  return { version, originHash, pins }
}
