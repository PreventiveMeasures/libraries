import assert from 'node:assert/strict'

import { show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

// `options` for a GET of one of `name`'s own URLs on the registry, and for
// nothing else: with NPM_TOKEN where it is set and the name is scoped, as
// every private package's is.
export function withNpmToken(name, url, options = {}) {
  const method = options.method ?? 'GET'
  assert.ok(method === 'GET' && url.startsWith(`${NPM_REGISTRY}/${name}/`), `Unexpected request for ${name}: ${method} ${url}`)
  const token = process.env.NPM_TOKEN
  return token && name.startsWith('@') ? { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } } : options
}

// The version document at `spec`, a version or `latest`, refused unless it
// is for `name`. A package's tarball is the registry's only other request.
export async function getDocument(method, name, spec) {
  const url = buildUrl(NPM_REGISTRY, [...name.split('/'), spec])
  const json = await request(url, withNpmToken(name, url, { as: 'json' }))
  assert.ok(json?.name === name, `${method}: the registry answered for ${show(json?.name)}, not ${name}`)
  return json
}
