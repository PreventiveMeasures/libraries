import assert from 'node:assert/strict'

import { assertArgs, assertion, matches, show } from '../args.js'
import { readJSON, writeJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl } from '../http.js'
import { getDocument } from './registry.js'

const DIR = 'npm/versions' // No expiry: the registry never takes a version twice, nor changes its dist.
// One sha512 and nothing else, as the registry writes it: a sha1, a second
// hash or an option is refused rather than trusted. 64 bytes leave the
// last character before `==` two bits, so only A, Q, g or w is canonical.
const assertIntegrity = assertion('"sha512-" and a base64 sha512', matches(/^sha512-[\dA-Za-z+/]{85}[AQgw]==$/u))

// `{ tarball, integrity }` and nothing else, the tarball exactly the
// registry's own URL for that version. Each field is read once, and only
// as the object's own, into a copy that is checked and used from then on:
// the caller's object can change while a request is out, and a field on
// its prototype is not one it has.
export function checkedDist(method, name, version, dist) {
  assertArgs(method, dist, { tarball: null, integrity: null }, 'dist')
  const [tarball, integrity] = ['tarball', 'integrity'].map((key) => (Object.hasOwn(dist, key) ? dist[key] : undefined))
  assertIntegrity(method, 'dist.integrity', integrity)
  const segments = name.split('/')
  const expected = buildUrl(NPM_REGISTRY, [...segments, '-', `${segments.at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `${method}: dist.tarball must be ${expected}, got ${show(tarball)}`)
  return { tarball, integrity }
}

const distOf = (method, name, version, json) => checkedDist(method, name, version, { tarball: json.dist?.tarball, integrity: json.dist?.integrity })

// Whether a version document is one to keep, or to take as kept: for that
// name and version, with a dist that passes.
function isKeepable(method, name, version, json) {
  if (json?.name !== name || json.version !== version) return false
  try {
    distOf(method, name, version, json)
    return true
  } catch {
    return false
  }
}

// A version's document as `cache` keeps it (readJSON), or none.
async function keptDocument(method, name, version, cache) {
  const json = await readJSON(DIR, `${name}@${version}`, cache)
  return isKeepable(method, name, version, json) ? json : undefined
}

// The registry's document, kept whole in `cache` once it is keepable; one
// whose dist is refused is answered all the same.
async function fetchDocument(method, name, version, cache) {
  const json = await getDocument(method, name, version)
  assert.ok(json.version === version, `${method}: the registry answered for ${name}@${show(json.version)}, not ${name}@${version}`)
  if (isKeepable(method, name, version, json)) await writeJSON(DIR, `${name}@${version}`, json, cache)
  return json
}

// A version's document, kept or else fetched, for what is not an
// integrity: a package's repo (advisories.js), as trusted as setCacheDir's
// repo records are.
export const getVersionDocument = async (method, name, version, cache) => await keptDocument(method, name, version, cache) ?? await fetchDocument(method, name, version, cache)

// A version's dist, from its document. The cache never supplies an
// integrity: a kept document is read only for a caller that already has
// the `integrity`, and one with another integrity throws, kept or fetched.
export async function getDist(method, name, version, integrity, cache) {
  const kept = integrity === undefined ? undefined : await keptDocument(method, name, version, cache)
  const dist = distOf(method, name, version, kept ?? await fetchDocument(method, name, version, cache))
  assert.ok(integrity === undefined || dist.integrity === integrity, `${method}: ${name}@${version} is ${dist.integrity} ${kept ? 'in the cache' : 'on the registry'}, not ${integrity}`)
  return dist
}
