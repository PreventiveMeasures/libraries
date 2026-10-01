import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertCrateName, assertCrateVersion, assertSha256, printable, show } from '../args.js'
import { verifiedDownload } from '../download.js'
import { CRATES_INDEX, CRATES_STATIC, buildUrl, encodeSegment, request } from '../http.js'

const DIR = 'cargo/crates' // No expiry: crates.io never takes a version twice.

// The sparse index, what cargo reads: a file per crate, by its lowercased
// name under 1/, 2/, 3/<first letter>/ or <1st-2nd>/<3rd-4th>/, with a
// JSON line per version, `cksum` the .crate's sha256.
async function getChecksum(method, name, version) {
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
  const entry = text.split('\n').filter(Boolean).map(parse).find((candidate) => candidate?.vers === version)
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

function assertCrate(method, name, version) {
  assertCrateName(method, 'name', name)
  assertCrateVersion(method, 'version', version)
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
