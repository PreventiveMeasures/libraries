import assert from 'node:assert/strict'

import { show } from '../args.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

// Private packages are always scoped.
export function withNpmToken(name, url, options = {}) {
  const method = options.method ?? 'GET'
  assert.ok(method === 'GET' && `${new URL(url)}` === url && url.startsWith(`${NPM_REGISTRY}/${name}/`), `Unexpected request for ${name}: ${method} ${url}`)
  const token = process.env.NPM_TOKEN
  return token && name.startsWith('@') ? { ...options, method, headers: { ...options.headers, Authorization: `Bearer ${token}` } } : options
}

export async function getDocument(method, name, spec) {
  const url = buildUrl(NPM_REGISTRY, [...name.split('/'), spec])
  const json = await request(url, withNpmToken(name, url, { as: 'json' }))
  assert.ok(json?.name === name, `${method}: the registry answered for ${show(json?.name)}, not ${name}`)
  return json
}
