import assert from 'node:assert/strict'

import { assertArgs, assertToken, assertTokenOrNull, assertUserAgent, optional } from '../args.js'
import { GITHUB_API, buildUrl, request } from '../http.js'

export const api = (segments, query) => buildUrl(GITHUB_API, segments, query)
export const repoApi = (repo, segments, query) => api(['repos', ...repo.split('/'), ...segments], query)
export const call = (headers, url, options) => request(url, { as: 'json', headers, ...options })

// `null` is explicit anonymous access, so a forgotten token is an error.
export function clientHeaders(method, options, anonymous) {
  assertArgs(method, options, { token: anonymous ? assertTokenOrNull : assertToken, userAgent: optional(assertUserAgent) })
  const { token, userAgent = '@preventive/upstream' } = options
  return {
    ...(token !== null && { Authorization: `Bearer ${token}` }),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  }
}

// All async, so a bad argument is always a rejection. Arguments past the
// method's own, per `fn.length`, are refused.
export function bindMethods(headers, methods) {
  return Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => {
    assert.ok(args.length < fn.length, `${name}: unexpected arguments`)
    return await fn(headers, ...args)
  }]))
}
