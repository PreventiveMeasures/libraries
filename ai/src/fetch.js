import { Agent, fetch as undiciFetch } from 'undici'

// The socket under fetch-json.js and nothing else: one WHATWG-shaped `fetch`. Everything that
// decides WHICH failures are re-asked, how long the waits are and how many requests are in flight
// stays in fetch-json.js, in one copy, on both builds — fetch.browser.js is the page's side of this
// same seam, chosen by the `#fetch` condition in package.json.

// 1 hour
const timeout = 3600e3

// undici defaults to 300s apiece, and a long thinking turn spends minutes before the first byte.
// Raised rather than disabled: a socket that is genuinely dead should still eventually surface as a
// failure the retry loop can classify.
const dispatcher = new Agent({
  bodyTimeout: timeout,
  headersTimeout: timeout,
})

// The dispatcher goes on first so a caller's own options win, which is the order this had when the
// call was still inline in fetch-json.js.
export const fetch = (url, options) => undiciFetch(url, { dispatcher, ...options })
