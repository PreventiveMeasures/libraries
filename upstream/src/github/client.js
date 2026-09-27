import { assertNoArgs, assertOptions, assertToken, assertTokenOrNull, assertUserAgent } from '../args.js'
import { GITHUB_API, buildUrl, request } from '../http.js'

export const api = (segments, query) => buildUrl(GITHUB_API, segments, query)

export async function call(headers, url, { as = 'json', ...options } = {}) {
  return await request(url, { headers, as, ...options })
}

// `null` is explicit anonymous access, so a forgotten token is an error.
export function clientHeaders(method, options, { anonymous }) {
  assertOptions(method, 'options', options, ['token', 'userAgent'])
  const { token, userAgent = '@preventive/upstream' } = options
  const assertTokenFor = anonymous ? assertTokenOrNull : assertToken
  assertTokenFor(method, 'token', token)
  assertUserAgent(method, 'userAgent', userAgent)
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
  const bound = {}
  for (const [name, fn] of Object.entries(methods)) {
    bound[name] = async (...args) => {
      assertNoArgs(name, args.slice(fn.length - 1))
      return await fn(headers, ...args)
    }
  }
  return bound
}
