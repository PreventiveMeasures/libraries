import assert from 'node:assert/strict'

import { assertArgs, assertion, matches, show } from '../args.js'
import { readJSON, writeJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, isNotFound, recover } from '../http.js'
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
async function keepDocument(method, name, version, json, cache) {
  assert.ok(json.version === version, `${method}: the registry answered for ${name}@${show(json.version)}, not ${name}@${version}`)
  if (isKeepable(method, name, version, json)) await writeJSON(DIR, `${name}@${version}`, json, cache)
  return json
}

const fetchDocument = async (method, name, version, cache) => await keepDocument(method, name, version, await getDocument(method, name, version), cache)

// A version's document, kept or else fetched, for what is not an
// integrity: a package's repo (advisories.js), as trusted as setCacheDir's
// repo records are. Null where the registry does not have that version:
// its 404 alone, never a failure of the cache's.
export async function getVersionDocument(method, name, version, cache) {
  const kept = await keptDocument(method, name, version, cache)
  if (kept) return kept
  const json = await getDocument(method, name, version).catch(recover(isNotFound, null))
  return json && await keepDocument(method, name, version, json, cache)
}

// The dist of a version document a cache answers, where it is that
// version's, its dist passes, and its tarball and integrity are `given`'s
// (checkedDist): a cache never supplies a dist, only confirms one.
export function matchingDist(method, name, version, json, given) {
  if (!isKeepable(method, name, version, json)) return undefined
  const dist = distOf(method, name, version, json)
  return dist.integrity === given.integrity && dist.tarball === given.tarball ? dist : undefined
}

// A version's document, and its dist checked. A kept document is read only
// for a caller that already has a dist, `given`, and answers with no
// request where it matches (matchingDist). Else, or without one, the
// registry is asked, and its document, kept in place of any other, throws
// where it does not.
export async function getVersion(method, name, version, given, cache) {
  if (given !== undefined) {
    const kept = await readJSON(DIR, `${name}@${version}`, cache)
    const dist = matchingDist(method, name, version, kept, given)
    if (dist) return { dist, json: kept }
  }
  const json = await fetchDocument(method, name, version, cache)
  const dist = distOf(method, name, version, json)
  if (given !== undefined) {
    assert.ok(dist.integrity === given.integrity, `${method}: ${name}@${version} is ${dist.integrity} on the registry, not ${given.integrity}`)
    assert.ok(dist.tarball === given.tarball, `${method}: ${name}@${version} is at ${dist.tarball} on the registry, not ${given.tarball}`)
  }
  return { dist, json }
}
