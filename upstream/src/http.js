import assert from 'node:assert/strict'

import { printable } from './args.js'

// Every request this package makes goes through here, and every URL it
// requests is built here: from one of a fixed set of origins, and path
// segments each checked to be URL-safe and not a dot segment. A value
// that could hold anything — a git ref, a path inside a repo — is
// percent-encoded first, with encodeSegment. The URL built then has to
// come back out of URL parsing exactly as it went in, so nothing it
// holds was read as a dot segment (`%2e%2e` is one), a query, a fragment
// or anything else the builder did not put there.

export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const GITHUB_API = 'https://api.github.com'
const ORIGINS = new Set([NPM_REGISTRY, GITHUB_API])

// Letters, digits, `.`, `_`, `~`, `-`, `@` (an npm scope) and percent
// escapes, and not `.` or `..`.
const isSegment = (value) => typeof value === 'string' && /^(?:[\w.~@-]|%[\dA-F]{2})+$/u.test(value) && value !== '.' && value !== '..'

// encodeURIComponent leaves `!'()*` as they are, which URL parsing also
// does; encoded here too, so an encoded segment is letters, digits,
// `-_.~` and escapes only.
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

// A failed request: `status` is the HTTP status the service answered
// with, so a caller can tell a 401 (log in again) or a 404 (no such
// thing, or no access to it) from the rest without reading the message.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

// A URL buildUrl made, checked again at the door: nothing reaches fetch
// that is not one.
function assertBuilt(url) {
  assert.equal(typeof url, 'string')
  const parsed = new URL(url)
  assert.ok(ORIGINS.has(parsed.origin) && parsed.href === url && !parsed.username && !parsed.password && !parsed.hash, `Unexpected URL: ${printable(url)}`)
}

// Header names as HTTP spells them, and values of printable ASCII: a line
// break in one would be a header of its own.
function assertHeaders(headers) {
  for (const [name, value] of Object.entries(headers)) {
    assert.ok(/^[A-Za-z][\w-]*$/u.test(name) && typeof value === 'string' && /^[ -~]*$/u.test(value), `Unexpected header: ${printable(name)}`)
  }
}

// How much of a body is read, and how long a request may take, by what it
// is read as: an API answer or a registry document is kilobytes, a file
// out of a repo at most GitHub's hundred megabytes, a tarball what it is.
// Past either, the request is abandoned rather than waited on or held.
const LIMITS = {
  json: { bytes: 64 * 1024 * 1024, ms: 30_000 },
  text: { bytes: 128 * 1024 * 1024, ms: 30_000 },
  bytes: { bytes: 512 * 1024 * 1024, ms: 300_000 },
}

// Of an error's body, only the start: enough to say what went wrong.
const ERROR_BODY_BYTES = 4096

// The request as sent, with its Response as it came back. Redirects are
// not followed unless `redirect: 'follow'` asks for it: a request made
// about one thing should be answered about that thing or fail, not
// quietly land on another. Not followed, a 3xx is a response that is not
// ok, like any other.
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

// A body, read a chunk at a time up to `limit` bytes. Past it, the rest
// is not read: `truncate` answers what came before, and otherwise it is
// an error — as it is straight away for a Content-Length that says so.
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

// The body of a successful response, read `as` the caller says it is —
// not as its content type claims, which proxies are known to drop or
// rewrite. Anything but a 2xx throws an HttpError, with the start of the
// body in its message.
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
