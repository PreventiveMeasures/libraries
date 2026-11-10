import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertArgs, assertCrate, assertCrateName, assertCrateVersion, assertSha256, assertion, isIterable, isStrings, optional, printable, show } from '../args.js'
import { assertCache, readRecord, writeRecord } from '../cache.js'
import { verifiedDownload } from '../download.js'
import { CRATES_INDEX, CRATES_STATIC, buildUrl, encodeSegment, isNotFound, recover, request } from '../http.js'
import { pool } from '../pool.js'

const DIR = 'cargo/crates' // No expiry: crates.io never takes a version twice.
const INDEX_DIR = 'cargo/index'
// A yank is news: kept as long as a repository's advisories.
const INDEX_TTL_MS = 90 * 60 * 1000
const CRATES_AT_ONCE = 8

// The sparse index, what cargo reads: a file per crate, by its lowercased
// name under 1/, 2/, 3/<first letter>/ or <1st-2nd>/<3rd-4th>/, with a
// JSON line per version.
async function readIndex(method, name) {
  const lower = name.toLowerCase()
  const prefix = lower.length < 3 ? [String(lower.length)] : lower.length === 3 ? ['3', lower[0]] : [lower.slice(0, 2), lower.slice(2, 4)]
  const text = await request(buildUrl(CRATES_INDEX, [...prefix, lower]), { as: 'text' })
  const parse = (line) => {
    try {
      return JSON.parse(line)
    } catch {
      assert.fail(`${method}: the index for ${name} has a line that is not JSON: ${printable(line.slice(0, 200))}`)
    }
  }
  return text.split('\n').filter(Boolean).map(parse)
}

async function getChecksum(method, name, version) {
  const entry = (await readIndex(method, name)).find((candidate) => candidate?.vers === version)
  assert.ok(entry, `${method}: the index has no ${name}@${version}`)
  assert.ok(entry.name === name, `${method}: the index answered for ${show(entry.name)}, not ${name}`)
  assertSha256(method, 'the index cksum', entry.cksum)
  return entry.cksum
}

// Cargo's own downloads, a directory per registry under
// $CARGO_HOME/registry/cache, each holding <name>-<version>.crate.
async function localPaths(name, version) {
  const root = join(resolve(process.env.CARGO_HOME || join(homedir(), '.cargo')), 'registry', 'cache')
  return (await readdir(root).catch(() => [])).map((registry) => join(root, registry, `${name}-${version}.crate`))
}

export async function verifyChecksum(name, version, checksum) {
  assertCrate('verifyChecksum', name, version)
  assertSha256('verifyChecksum', 'checksum', checksum)
  const cksum = await getChecksum('verifyChecksum', name, version)
  assert.ok(cksum === checksum, `verifyChecksum: ${name}@${version} is ${cksum} on crates.io, not ${checksum}`)
}

export async function getCrate(name, version, checksum) {
  assertCrate('getCrate', name, version)
  if (checksum !== undefined) assertSha256('getCrate', 'checksum', checksum)
  const expected = checksum ?? await getChecksum('getCrate', name, version)
  const locate = () => buildUrl(CRATES_STATIC, ['crates', name, `${name}-${encodeSegment(version)}.crate`])
  return await verifiedDownload({ method: 'getCrate', dir: DIR, what: `${name}@${version}`, ext: 'crate', algorithm: 'sha256', expected, local: await localPaths(name, version), locate })
}

// A crate's versions on crates.io, yanked or not; null where it has none.
async function indexVersions(name, cache) {
  const kept = await readRecord(INDEX_DIR, name, cache, INDEX_TTL_MS)
  if (isStrings(kept?.published) && isStrings(kept.yanked)) return kept
  const entries = await readIndex('yankedVersions', name).catch(recover(isNotFound, null))
  if (entries === null) return null
  for (const entry of entries) {
    assert.ok(entry?.name === name, `yankedVersions: the index answered for ${show(entry?.name)}, not ${name}`)
    assert.ok(typeof entry.vers === 'string' && typeof entry.yanked === 'boolean', `yankedVersions: malformed index line for ${name}`)
  }
  const versions = { published: entries.filter((entry) => !entry.yanked).map((entry) => entry.vers), yanked: entries.filter((entry) => entry.yanked).map((entry) => entry.vers) }
  await writeRecord(INDEX_DIR, name, versions, cache)
  return versions
}

const assertVersions = assertion('a non-empty array', (value) => Array.isArray(value) && value.length > 0)

export async function yankedVersions(crates, options = {}) {
  assertArgs('yankedVersions', options, { cache: optional(assertCache) })
  assert.ok(isIterable(crates), 'yankedVersions: crates must be an iterable of { name, versions }')
  const asked = new Map()
  for (const crate of crates) {
    assertArgs('yankedVersions', crate, { name: assertCrateName, versions: assertVersions }, 'crate')
    for (const version of crate.versions) assertCrateVersion('yankedVersions', 'crate.versions', version)
    const versions = asked.get(crate.name) ?? asked.set(crate.name, new Set()).get(crate.name)
    for (const version of crate.versions) versions.add(version)
  }
  const names = [...asked.keys()]
  const found = await pool(names, CRATES_AT_ONCE, (name) => indexVersions(name, options.cache))
  return new Map(names.map((name, i) => {
    const [yanked, published] = [new Set(found[i]?.yanked), new Set(found[i]?.published)]
    const versions = [...asked.get(name)]
    return [name, { yanked: versions.filter((version) => yanked.has(version)), unknown: versions.filter((version) => !yanked.has(version) && !published.has(version)) }]
  }))
}
