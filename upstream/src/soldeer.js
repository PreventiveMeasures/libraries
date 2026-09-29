import assert from 'node:assert/strict'

import { assertSha256, assertion, matches, show } from './args.js'
import { sha256, verifiedDownload } from './download.js'
import { SOLDEER_API, SOLDEER_REVISIONS, buildUrl, request } from './http.js'

const DIR = 'soldeer/zips' // No expiry: the registry refuses a version it already has.
// Soldeer's own rule for a name: 3 to 100 of lowercase letters, digits and
// `-`, starting with one of them or `@`, ending with a letter or digit.
const assertName = assertion('a Soldeer package name', matches(/^(?=.{3,100}$)[@\da-z][\da-z-]*[\da-z]$/u))
// Soldeer takes any version but an empty one. Its registry has semver
// (`5.7.0-rc.0`, `1.0.2-solc-0.8-simulate`), bare numbers and commit hashes.
const assertVersion = assertion('letters, digits, `.`, `_`, `+` and `-`', matches(/^(?=.{1,128}$)[\dA-Za-z][\w.+-]*$/u))

// Where the registry keeps the version's zip; it says nothing of what the
// zip hashes to.
async function zipUrl(name, version) {
  const json = await request(buildUrl(SOLDEER_API, ['api', 'v1', 'revision-cli'], { project_name: name, revision: version }), { as: 'json' })
  const revision = Array.isArray(json?.data) ? json.data[0] : undefined
  assert.ok(revision?.version === version, `getZip: the registry answered for ${show(revision?.version)}, not ${name}@${version}`)
  const prefix = `${SOLDEER_REVISIONS}/${name}/`
  assert.ok(typeof revision.url === 'string' && revision.url.startsWith(prefix), `getZip: the registry keeps ${name}@${version} outside ${prefix}`)
  return revision.url
}

// The registry has no hash to check a zip against, so the caller brings
// one, as soldeer.lock records it.
export async function getZip(name, version, checksum) {
  assertName('getZip', 'name', name)
  assertVersion('getZip', 'version', version)
  assertSha256('getZip', 'checksum', checksum)
  return await verifiedDownload({ method: 'getZip', dir: DIR, what: `${name}@${version}`, ext: 'zip', digest: sha256, expected: checksum, locate: () => zipUrl(name, version) })
}
