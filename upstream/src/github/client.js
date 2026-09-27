import { assertNoArgs, assertOptions, assertToken, assertTokenOrNull, assertUserAgent } from '../args.js'
import { GITHUB_API, buildUrl, request } from '../http.js'

// A GitHub API URL, from path segments and a query: see buildUrl for what
// each is held to.
export const api = (segments, query) => buildUrl(GITHUB_API, segments, query)

// One API call, as JSON unless `as` says otherwise.
export async function call(headers, url, { as = 'json', ...options } = {}) {
  return await request(url, { headers, as, ...options })
}

// The headers every request carries. `token` is required, and `null`
// rather than absent for an anonymous client where one is allowed — which
// reads public repositories without anyone's credentials — so a caller
// that forgot one gets an error, not anonymous access.
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

// The client's methods, bound to its headers. Every one async, so a bad
// argument is always a rejection, never a throw from one method and a
// rejection from the next. A method takes one options object or nothing,
// as its own parameter list after `headers` says, and anything past that
// is refused rather than ignored.
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
