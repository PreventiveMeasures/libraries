import assert from 'node:assert/strict'

import { NPM_REGISTRY, request } from '../http.js'

// NPM_TOKEN, where it is set, for a private package on the registry: sent
// with every request for a scoped name, as every private package's is, and
// with none for an unscoped one, nor anywhere but the registry.
export async function registryRequest(name, url, options) {
  assert.ok(url.startsWith(`${NPM_REGISTRY}/`), `Unexpected registry URL: ${url}`)
  const token = process.env.NPM_TOKEN
  if (!token || !name.startsWith('@')) return await request(url, options)
  return await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } })
}
