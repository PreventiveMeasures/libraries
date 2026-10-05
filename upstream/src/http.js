import assert from 'node:assert/strict'

import { matches, printable } from './args.js'

// Every request goes through here, to a URL from buildUrl, which has to
// come back out of `new URL()` unchanged: no segment can then be read as
// `..` (`%2e%2e` included), a query or a fragment.

export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const GITHUB_API = 'https://api.github.com'
export const OSV_API = 'https://api.osv.dev'
export const CRATES_API = 'https://crates.io'
export const PACKAGIST_REPO = 'https://repo.packagist.org'
export const CRATES_INDEX = 'https://index.crates.io'
export const CRATES_STATIC = 'https://static.crates.io'
export const SOLDEER_API = 'https://api.soldeer.xyz'
export const SOLDEER_REVISIONS = 'https://soldeer-revisions.s3.amazonaws.com'
export const DRUPAL_FTP = 'https://ftp.drupal.org'
export const MAX_BYTES = 512 * 1024 * 1024

const ORIGINS = new Set([NPM_REGISTRY, GITHUB_API, OSV_API, CRATES_API, PACKAGIST_REPO, CRATES_INDEX, CRATES_STATIC, SOLDEER_API, SOLDEER_REVISIONS, DRUPAL_FTP])
const isSegment = matches(/^(?!\.\.?$)(?:[\w.~@-]|%[\dA-F]{2})+$/u)
const isQueryKey = matches(/^[a-z_]+(?:\[\])?$/u)
const isQueryValue = (value) => (typeof value === 'string' && value !== '') || (Number.isSafeInteger(value) && value >= 0)
// Only a `key[]` repeats, and it always does.
const isQuery = ([key, value]) => isQueryKey(key) && (key.endsWith('[]') ? Array.isArray(value) && value.length > 0 && value.every(isQueryValue) : isQueryValue(value))
// A line break in a value would start a header of its own.
const isHeader = ([name, value]) => /^[A-Za-z][\w-]*$/u.test(name) && matches(/^[ -~]*$/u)(value)
const LIMITS = {
  json: { bytes: 64 * 1024 * 1024, ms: 30_000 },
  text: { bytes: 128 * 1024 * 1024, ms: 30_000 },
  bytes: { bytes: MAX_BYTES, ms: 300_000 },
}
const decoder = new TextDecoder('utf-8', { fatal: true })

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export const isNotFound = (err) => err instanceof HttpError && err.status === 404
export const recover = (expected, value) => (err) => {
  if (!expected(err)) throw err
  return value
}

export function decode(bytes, from) {
  try {
    return decoder.decode(bytes)
  } catch (cause) {
    throw new Error(`Malformed UTF-8 from ${from}`, { cause })
  }
}

// encodeURIComponent leaves `!'()*` as they are.
export function encodeSegment(value) {
  assert.equal(typeof value, 'string')
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.codePointAt(0).toString(16).toUpperCase()}`)
}

export function buildUrl(origin, segments, query = {}) {
  assert.ok(ORIGINS.has(origin), `Unexpected origin: ${origin}`)
  assert.ok(segments.length > 0 && segments.every(isSegment), `Unexpected URL path segment in ${JSON.stringify(segments)}`)
  assert.ok(Object.entries(query).every(isQuery), `Unexpected query parameter in ${JSON.stringify(query)}`)
  const search = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => [value].flat().map((item) => [key, item]))).toString()
  const href = `${origin}/${segments.join('/')}${search && `?${search}`}`
  assert.equal(new URL(href).href, href, `URL changed in parsing: ${href}`)
  return href
}

// Redirects aren't followed unless asked: an answer about another repo is
// worse than an error.
export async function send(url, { method = 'GET', headers = {}, body, redirect = 'manual', as } = {}) {
  const parsed = typeof url === 'string' ? URL.parse(url) : null
  assert.ok(parsed?.href === url && ORIGINS.has(parsed.origin) && !parsed.username && !parsed.password && !parsed.hash, `Unexpected URL: ${printable(url)}`)
  assert.ok(['GET', 'POST'].includes(method), `Unexpected method: ${method}`)
  assert.ok(['manual', 'follow'].includes(redirect), `Unexpected redirect mode: ${redirect}`)
  assert.ok(Object.hasOwn(LIMITS, as), `Unexpected response type: ${as}`)
  assert.ok(Object.entries(headers).every(isHeader), 'Unexpected header')
  const json = body === undefined ? {} : { headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  return await fetch(url, { method, headers, redirect, signal: AbortSignal.timeout(LIMITS[as].ms), ...json })
}

export async function readBody(res, limit, { truncate = false } = {}) {
  const declared = Number(res.headers.get('content-length'))
  if (!truncate && declared > limit) {
    await res.body?.cancel()
    throw new Error(`Response too large: ${declared} bytes, over ${limit}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    chunks.push(chunk)
    size += chunk.byteLength
    if (size <= limit) continue
    if (!truncate) throw new Error(`Response too large: over ${limit} bytes`)
    break
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer(), 0, Math.min(size, limit))
}

function parse(bytes, url, as) {
  if (as === 'bytes') return bytes
  const text = decode(bytes, url)
  if (as === 'text') return text
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Malformed JSON from ${url}: ${printable(text.slice(0, 200))}`, { cause })
  }
}

// Read as the caller says, not by content type, which proxies drop or
// rewrite; answered with the response's headers.
export async function requestWithHeaders(url, options) {
  const res = await send(url, options)
  if (!res.ok) {
    // A stream decode holds back a character cut at the limit rather than refusing it.
    const text = await readBody(res, 4096, { truncate: true }).then((bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })).catch(() => '')
    throw new HttpError(res.status, `${options.method ?? 'GET'} ${url} ${res.status}: ${printable(text)}`)
  }
  return { body: parse(await readBody(res, LIMITS[options.as].bytes), url, options.as), headers: res.headers }
}

export const request = async (url, options) => (await requestWithHeaders(url, options)).body
