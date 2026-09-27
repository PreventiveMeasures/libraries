import { assertNoArgs, assertOptions, assertToken, assertUserAgent } from './args.js'

export const API = 'https://api.github.com'

// A failed request, with the HTTP status on it, so a caller can tell a
// 401 (log in again) or a 404 (no such thing, or no access to it) from
// the rest without reading the message.
export class GitHubError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

// Redirects are not followed: GitHub answers a renamed or transferred
// repo with one, and a request made about one repo should be answered
// about that repo or fail, not quietly land on another. A 3xx is thrown
// like any other status that is not a success.
export async function request(headers, method, path, { body, accept } = {}) {
  const reqHeaders = { ...headers }
  if (accept) reqHeaders.Accept = accept
  const opts = { method, headers: reqHeaders, redirect: 'manual' }
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path} ${res.status}: ${text}`)
  if (!text) return null
  const contentType = res.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? JSON.parse(text) : text
}

// The headers every request carries. `token` is required, and `null`
// rather than absent for an anonymous client where one is allowed — which
// reads public repositories without anyone's credentials — so a caller
// that forgot one gets an error, not anonymous access.
export function clientHeaders(method, options, { anonymous }) {
  assertOptions(method, options, ['token', 'userAgent'])
  const { token, userAgent = '@preventive/upstream' } = options
  assertToken(method, token, anonymous)
  assertUserAgent(method, userAgent)
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
