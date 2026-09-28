// Shared by the GitHub client tests: a stubbed fetch, and the answers it
// gives.

export const SHA = '3f786850e387550fdab836ed7e6dc881de23001b'
export const SHA2 = '89e6c98d92887913cadf06b2adb97f26cde4849b'

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

// Answers each request with `respond(call)` and keeps every one it was
// asked, so a test can check what went over the wire.
export function stubGitHub(respond) {
  const calls = []
  globalThis.fetch = (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', headers: options.headers, redirect: options.redirect, body: options.body && JSON.parse(options.body) }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return calls
}

// For a test that must not reach the network at all.
export function forbidRequests() {
  return stubGitHub(({ url }) => {
    throw new Error(`unexpected request: ${url}`)
  })
}
