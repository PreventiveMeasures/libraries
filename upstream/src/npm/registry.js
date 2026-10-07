import assert from 'node:assert/strict'

import { show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

// The first of these that is set and not empty.
const npmToken = () => process.env.PREVENTIVE_MEASURES_NPM_TOKEN || process.env.STASIS_NPM_TOKEN || process.env.NPM_TOKEN

// Private packages are always scoped.
export function withNpmToken(name, url, options = {}) {
  const method = options.method ?? 'GET'
  const own = url === `${NPM_REGISTRY}/${name}` || url.startsWith(`${NPM_REGISTRY}/${name}/`)
  assert.ok(method === 'GET' && `${new URL(url)}` === url && own, `Unexpected request for ${name}: ${method} ${url}`)
  const token = npmToken()
  return token && name.startsWith('@') ? { ...options, method, headers: { ...options.headers, Authorization: `Bearer ${token}` } } : options
}

// A version's document, or with no `spec` the whole package's, every
// version's and `time`.
export async function getDocument(method, name, ...spec) {
  const url = buildUrl(NPM_REGISTRY, [...name.split('/'), ...spec])
  const json = await request(url, withNpmToken(name, url, { as: 'json' }))
  assert.ok(json?.name === name, `${method}: the registry answered for ${show(json?.name)}, not ${name}`)
  return json
}
