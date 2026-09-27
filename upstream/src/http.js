import assert from 'node:assert/strict'

import { printable } from './args.js'

// Every request goes through here, to a URL from buildUrl, which has to
// come back out of `new URL()` unchanged: no segment can then be read as
// `..` (`%2e%2e` included), a query or a fragment.

export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const GITHUB_API = 'https://api.github.com'
const ORIGINS = new Set([NPM_REGISTRY, GITHUB_API])

const isSegment = (value) => typeof value === 'string' && /^(?:[\w.~@-]|%[\dA-F]{2})+$/u.test(value) && value !== '.' && value !== '..'

// encodeURIComponent leaves `!'()*` as they are.
export function encodeSegment(value) {
  assert.equal(typeof value, 'string')
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.codePointAt(0).toString(16).toUpperCase()}`)
}

const isQueryKey = (value) => /^[a-z_]+$/u.test(value)
const isQueryValue = (value) => (typeof value === 'string' && value !== '') || (Number.isSafeInteger(value) && value >= 0)

export function buildUrl(origin, segments, query = {}) {
  assert.ok(ORIGINS.has(origin), `Unexpected origin: ${origin}`)
  assert.ok(Array.isArray(segments) && segments.length > 0, 'Expected path segments')
  for (const segment of segments) assert.ok(isSegment(segment), `Unexpected URL path segment: ${JSON.stringify(segment)}`)
  const base = `${origin}/${segments.join('/')}`
  const url = new URL(base)
  for (const [key, value] of Object.entries(query)) {
    assert.ok(isQueryKey(key) && isQueryValue(value), `Unexpected query parameter: ${key}`)
    url.searchParams.set(key, String(value))
  }
  const href = url.href
  assert.ok((href === base || href.startsWith(`${base}?`)) && new URL(href).href === href, `URL changed in parsing: ${base} became ${href}`)
  return href
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function assertBuilt(url) {
  assert.equal(typeof url, 'string')
  const parsed = new URL(url)
  assert.ok(ORIGINS.has(parsed.origin) && parsed.href === url && !parsed.username && !parsed.password && !parsed.hash, `Unexpected URL: ${printable(url)}`)
}

// A line break in a value would start a header of its own.
function assertHeaders(headers) {
  for (const [name, value] of Object.entries(headers)) {
    assert.ok(/^[A-Za-z][\w-]*$/u.test(name) && typeof value === 'string' && /^[ -~]*$/u.test(value), `Unexpected header: ${printable(name)}`)
  }
}

// API documents are kilobytes, a GitHub file is at most 100 MB, a tarball
// is what it is.
const LIMITS = {
  json: { bytes: 64 * 1024 * 1024, ms: 30_000 },
  text: { bytes: 128 * 1024 * 1024, ms: 30_000 },
  bytes: { bytes: 512 * 1024 * 1024, ms: 300_000 },
}

const ERROR_BODY_BYTES = 4096

// Redirects aren't followed unless asked: an answer about another repo is
// worse than an error.
export async function send(url, { method = 'GET', headers = {}, body, redirect = 'manual', as = 'json' } = {}) {
  assertBuilt(url)
  assert.ok(['GET', 'POST'].includes(method), `Unexpected method: ${method}`)
  assert.ok(['manual', 'follow'].includes(redirect), `Unexpected redirect mode: ${redirect}`)
  assert.ok(Object.hasOwn(LIMITS, as), `Unexpected response type: ${as}`)
  assertHeaders(headers)
  const init = { method, headers: { ...headers }, redirect, signal: AbortSignal.timeout(LIMITS[as].ms) }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return await fetch(url, init)
}

export async function readBody(res, limit, { truncate = false } = {}) {
  const declared = Number(res.headers.get('content-length'))
  if (!truncate && declared > limit) {
    await res.body?.cancel()
    throw new Error(`Response too large: ${declared} bytes, over ${limit}`)
  }
  const chunks = []
  let size = 0
  const reader = res.body?.getReader()
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true }
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      if (!truncate) throw new Error(`Response too large: over ${limit} bytes`)
      break
    }
  }
  const bytes = new Uint8Array(Math.min(size, limit))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at)
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

const decoder = new TextDecoder()

// Read as the caller says, not by content type, which proxies drop or
// rewrite.
export async function request(url, options) {
  const { as } = options
  assert.ok(Object.hasOwn(LIMITS, as), `Unexpected response type: ${as}`)
  const res = await send(url, options)
  if (!res.ok) {
    const text = decoder.decode(await readBody(res, ERROR_BODY_BYTES, { truncate: true }).catch(() => new Uint8Array(0)))
    throw new HttpError(res.status, `${options.method ?? 'GET'} ${url} ${res.status}: ${printable(text)}`)
  }
  const bytes = await readBody(res, LIMITS[as].bytes)
  if (as === 'bytes') return bytes
  const text = decoder.decode(bytes)
  if (as === 'text') return text
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Malformed JSON from ${url}: ${printable(text.slice(0, 200))}`, { cause: err })
  }
}
