// fetch.js for a browser build, chosen by the `#fetch` condition in package.json: the page's own
// fetch, unwrapped. The retry budget, the backoff and the concurrency ceiling are all in
// fetch-json.js and shared with the Node build, so there is nothing to restate here.

// Two things the Node transport sets that have no equivalent here, neither worth faking.

// The 1-hour header/body timeout. A browser owns its own request timeouts and exposes no knob for
// them; `AbortSignal.timeout()` is not that knob — it fires on wall-clock elapsed rather than on a
// stalled socket, so a long thinking turn that is streaming along fine would be cancelled at the
// deadline. A hung request here ends when the browser gives up on it.

// A connection pool. The browser's is per-origin and not ours to configure, which also makes the
// concurrency ceiling in fetch-json.js the only cap this build controls.

// Worth knowing rather than worked around: every hosted provider in providers.js is cross-origin
// from a page and none of them answers one with CORS headers. A browser build reaches them through a
// same-origin proxy of the caller's own, or reaches a local server (ollama, with its origin
// allowed) — and a key shipped to a page is readable by whoever holds the page either way.
// Reached through globalThis on every call, for two reasons. It has to be a property access at all
// because the export shadows the global: `(url, options) => fetch(url, options)` names itself and
// recurses. And it is read per call rather than captured at module load so that a page which installs
// its own fetch — a test double, request instrumentation, a service-worker shim — is actually used;
// a binding captured at import time would silently ignore all three.
export const fetch = (url, options) => globalThis.fetch(url, options)
