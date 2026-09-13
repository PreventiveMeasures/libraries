import { Agent, fetch } from 'undici'
import { Queue } from '@chalker/queue'

// 1 hour
const timeout = 3600e3

const dispatcher = new Agent({
  bodyTimeout: timeout,
  headersTimeout: timeout,
})

export const RETRIES = 2

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// Global cap on in-flight model requests. The file-level queue in runner.js orders work so
// cache-adjacent requests stay close together, but it can't cap fan-out inside a single slot (e.g.
// isolate mode fires one request per export from within one file slot). This queue is the hard
// concurrency ceiling that every fetchJSON goes through. Defaults to unbounded until
// `setFetchConcurrency()` narrows it at startup.
let queue = new Queue(Infinity)

export function setFetchConcurrency(limit) {
  queue = new Queue(limit)
}

// How many times a TRANSIENT upstream failure is re-asked. Everything else keeps the flat RETRIES
// budget it always had — see fetchJSON. Narrowed at startup, like the concurrency above. A caller's
// own default lives with the flag that sets it rather than being copied here, so a caller that
// never calls the setter keeps RETRIES instead of inheriting a second, drifting copy of the number.
let transientRetries = RETRIES

export function setFetchRetries(n) {
  // Guarded, because the budget below is a Math.max: handed a non-integer — `parsePositiveInt`
  // returns undefined for a flag that isn't set — it would evaluate to NaN, `used < NaN` would be
  // false, and every transient failure would get ZERO retries, the exact inverse of the floor this
  // is supposed to hold.
  transientRetries = Number.isSafeInteger(n) && n > 0 ? n : RETRIES
}

// The failure that ends a long run when the model is fine and the road to it is not: a gateway that
// cannot reach its upstream right now. It arrives under more than one status — 429 from a rate
// limiter, 5xx from a proxy, and (seen from the Moonshot route on kimi-k3) a plain 400 whose BODY
// carries the real reason:
//
//   API 400: {"error":{"code":"upstream_unavailable","message":"Model unavailable."}}
//
// so the status alone cannot classify it and the body has the last word. That matters in both
// directions: a 400 naming this code was a fine request a moment earlier and deserves waiting for,
// while a 400 over a malformed body will read the same on every attempt and deserves none.
//
// The code is read out of the PARSED envelope, never matched as a substring of the body. This tool
// posts source code, gateways echo the offending request back in a permanent 4xx, and this file now
// contains the token itself — a substring match hands a request that can never succeed the full
// backoff budget, on every file that mentions it.
//
// Codes are matched literally rather than by prefix — a set that grows when a new one is SEEN, not
// when one is imagined.
const TRANSIENT_CODES = ['upstream_unavailable']

function namesTransientCode(body) {
  // Cheap gate first: an echoed request body runs to megabytes and there is nothing to parse unless
  // the token is somewhere in it. The parse is what actually decides — the gate only avoids paying
  // for it.
  if (!TRANSIENT_CODES.some((code) => body.includes(code))) return false
  let json
  try { json = JSON.parse(body) } catch { return false }
  return TRANSIENT_CODES.includes(json?.error?.code ?? json?.code)
}

export function isTransientHttpFailure(status, body = '') {
  if (status === 429 || status >= 500) return true
  return namesTransientCode(body)
}

// `Retry-After` is the one number here that isn't a guess, so it wins when a server sends one. Both
// forms RFC 9110 defines are read, and the result is capped: a server asking for an hour would
// otherwise park a slot of the concurrency window for an hour.
//
// delta-seconds is matched as `1*DIGIT` rather than handed to Number(), which also accepts what is
// not a delta at all: `0x10` as 16s, `1e3` as an hour, ` 5` and `+5` and `-5`. The list form is
// matched with it because a proxy chain leaving TWO Retry-After headers on one response comes back
// from undici comma-joined (`5, 10`), and that string is neither a number nor a date — it reaches
// Date.parse, which reads it as 2001-05-10 and clamps a wait of ZERO out of a server asking for
// five seconds. The first value is the origin's own.
const MAX_RETRY_AFTER = 60_000
const DELTA_SECONDS = /^\d+(?:\s*,\s*\d+)*$/u

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null
  const clamp = (ms) => Math.min(Math.max(ms, 0), MAX_RETRY_AFTER)
  if (DELTA_SECONDS.test(value)) return clamp(Number(value.split(',')[0]) * 1000)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return clamp(at - now)
}

// Exponential and jittered: 1s, 2s, 4s, 8s, 16s, then capped. The flat second this replaced retried
// into the same wall three times in three seconds — and, because a whole concurrency window is
// usually rejected together, retried in lockstep, which is the shape an overloaded upstream least
// wants to see. The jitter spreads that window out.
const BASE_DELAY = 1000
const MAX_DELAY = 30_000
const JITTER = 0.25

export function retryDelayMs(attempt, retryAfter = null) {
  const after = parseRetryAfter(retryAfter)
  // A server-sent wait wins, but never downwards past the flat second the old loop always took.
  // `Retry-After: 0` is legal, a negative delta and an HTTP date already past under a second of
  // clock skew both clamp to 0, and honouring that verbatim spends the entire budget in
  // milliseconds — a tighter hammer on an upstream that just said stop than the one this backoff
  // exists to replace.
  if (after !== null) return Math.max(after, BASE_DELAY)
  const base = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY)
  return base + Math.floor(Math.random() * base * JITTER)
}

// Carries what the retry loop needs to classify and pace a failure. The message is byte-for-byte
// what it always was (`API <status>: <body>`), and the three fields are non-enumerable so that
// every log line, cached invalid-response reason and `Fatal: …` report reads the same as before —
// left enumerable, util.inspect appends them to the console dump and JSON.stringify starts emitting
// them, printing the whole response body a second time where a plain Error printed it once.
//
// Named UpstreamError rather than HttpError deliberately: a server's own HttpError is a status to
// send BACK to a client, this one is a status RECEIVED from an upstream, and the two can meet in
// one process.
class UpstreamError extends Error {
  constructor(status, body, retryAfter) {
    super(`API ${status}: ${body}`)
    Object.defineProperties(this, {
      name: { value: 'UpstreamError', configurable: true },
      status: { value: status, configurable: true },
      body: { value: body, configurable: true },
      retryAfter: { value: retryAfter, configurable: true },
    })
  }
}

// Retry lines carry the reason, not the whole page. A gateway that echoes the offending request
// answers with the whole request back, and a caller capturing this process's stderr may keep only
// its first chunk, so an unbounded line repeated once per attempt evicts the `Fatal: …` that
// explains why the run actually died. The full body still rides the throw.
const LOG_BODY_LIMIT = 200

function retryReason(err) {
  if (!(err instanceof UpstreamError) || err.body.length <= LOG_BODY_LIMIT) return err.message
  return `API ${err.status}: ${err.body.slice(0, LOG_BODY_LIMIT)}…`
}

export async function fetchJSON(url, options, { debug, label } = {}) {
  await queue.claim()
  try {
    // Each class counts its OWN re-asks. A single shared counter let a transient prelude spend the
    // flat budget a later failure was entitled to: two 429s followed by a 200 carrying non-JSON
    // rethrew the parse error with none of its two tries left.
    const used = { transient: 0, other: 0 }
    for (;;) {
      try {
        if (debug && label) console.debug(`[debug] ${label}`)
        const res = await fetch(url, { dispatcher, ...options })
        if (!res.ok) {
          // Read outside the throw. Inside the argument list, a body that fails mid-stream (an
          // overloaded gateway dropping the socket after its headers) rejects before the error
          // exists at all, and the 503 that would have earned the `--retries` budget arrives as a
          // bare transport failure that does not.
          const body = await res.text().catch(() => '')
          throw new UpstreamError(res.status, body, res.headers.get('retry-after'))
        }
        return await res.json()
      } catch (err) {
        // A transient upstream failure gets the `--retries` budget and backs off; everything else —
        // a malformed request, a bad key, a dropped socket — keeps the flat second and the two
        // tries it always had. Never FEWER than RETRIES either way, so no failure is retried less
        // than it used to be, whatever `--retries` says.
        const transient = err instanceof UpstreamError && isTransientHttpFailure(err.status, err.body)
        const kind = transient ? 'transient' : 'other'
        const attempt = used[kind]
        const budget = transient ? Math.max(RETRIES, transientRetries) : RETRIES
        if (attempt < budget) {
          used[kind] = attempt + 1
          const wait = transient ? retryDelayMs(attempt, err.retryAfter) : BASE_DELAY
          console.error(`[retry ${attempt + 1}/${budget} in ${(wait / 1000).toFixed(1)}s] ${retryReason(err)}`)
          await delay(wait)
          continue
        }
        throw err
      }
    }
  } finally {
    queue.release()
  }
}
