import assert from 'node:assert/strict'

import { assertSha256, assertSoldeerPackage, show } from './args.js'
import { verifiedDownload } from './download.js'
import { SOLDEER_API, SOLDEER_REVISIONS, buildUrl, request } from './http.js'

const DIR = 'soldeer/zips' // No expiry: the registry refuses a version it already has.

// Where the registry keeps the version's zip; it says nothing of what the
// zip hashes to.
async function zipUrl(name, version) {
  const json = await request(buildUrl(SOLDEER_API, ['api', 'v1', 'revision-cli'], { project_name: name, revision: version }), { as: 'json' })
  const revision = json?.data?.[0]
  assert.ok(revision?.version === version, `getZip: the registry answered for ${show(revision?.version)}, not ${name}@${version}`)
  const prefix = `${SOLDEER_REVISIONS}/${name}/`
  assert.ok(typeof revision.url === 'string' && revision.url.startsWith(prefix), `getZip: the registry keeps ${name}@${version} outside ${prefix}`)
  return revision.url
}

// The registry has no hash to check a zip against, so the caller brings
// one, as soldeer.lock records it.
export async function getZip(name, version, checksum) {
  assertSoldeerPackage('getZip', name, version)
  assertSha256('getZip', 'checksum', checksum)
  return await verifiedDownload({ method: 'getZip', dir: DIR, what: `${name}@${version}`, ext: 'zip', algorithm: 'sha256', expected: checksum, locate: () => zipUrl(name, version) })
}
