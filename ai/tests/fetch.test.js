import http from 'node:http'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { RETRIES, fetchJSON, isTransientHttpFailure, parseRetryAfter, retryDelayMs, setFetchRetries } from '../src/fetch.js'

// The body a kimi-k3 run dies on, verbatim. It arrives under two statuses
// — a 400 as often as a 429 — which is the whole reason the classifier
// reads the body and not just the status.
const UNAVAILABLE = '{"error":{"code":"upstream_unavailable","message":"Model unavailable."}}'

describe('isTransientHttpFailure', () => {
  it('flags a rate limit and every server error', () => {
    assert.equal(isTransientHttpFailure(429, ''), true)
    assert.equal(isTransientHttpFailure(500, ''), true)
    assert.equal(isTransientHttpFailure(503, ''), true)
    assert.equal(isTransientHttpFailure(529, ''), true)
  })

  it('flags an upstream-unavailable body under ANY status', () => {
    // The 400 is the case a status-only rule gets wrong: the request was
    // fine, the road to the model was not.
    assert.equal(isTransientHttpFailure(400, UNAVAILABLE), true)
    assert.equal(isTransientHttpFailure(429, UNAVAILABLE), true)
  })

  it('reads the CODE, not the body it is spelled in', () => {
    // A caller may post source code, and gateways echo the offending request
    // back, so a body that merely QUOTES the token — as the code right
    // here does — is not an upstream that went away. Matching it
    // as a substring bought a permanently-failing request the whole
    // backoff budget, on every file that mentioned it.
    assert.equal(isTransientHttpFailure(400, '{"error":{"message":"Invalid request near: [\'upstream_unavailable\']"}}'), false)
    assert.equal(isTransientHttpFailure(400, 'upstream_unavailable'), false)
    assert.equal(isTransientHttpFailure(400, '{"code":"upstream_unavailable"}'), true)
  })

  it('leaves an ordinary client error alone', () => {
    // A malformed body, a bad key, a model that does not exist: each will
    // read the same on every attempt, so none earns the larger budget.
    assert.equal(isTransientHttpFailure(400, '{"error":{"message":"messages: field required"}}'), false)
    assert.equal(isTransientHttpFailure(401, '{"error":{"message":"invalid api key"}}'), false)
    assert.equal(isTransientHttpFailure(404, '{"error":{"message":"model not found"}}'), false)
    assert.equal(isTransientHttpFailure(400), false)
  })
})

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z')

  it('reads delta-seconds', () => {
    assert.equal(parseRetryAfter('5', NOW), 5000)
    assert.equal(parseRetryAfter('0', NOW), 0)
  })

  it('reads the origin\'s value out of a duplicated header', () => {
    // Two Retry-After headers (an origin and a proxy in front of it) reach
    // undici comma-joined. `5, 10` is neither a number nor a date, so it
    // falling through to Date.parse reads it as 2001-05-10, i.e. a wait of
    // zero out of a server asking for five seconds.
    assert.equal(parseRetryAfter('5, 10', NOW), 5000)
    assert.equal(parseRetryAfter('10, 5', NOW), 10_000)
  })

  it('refuses a number that is not a delta-seconds', () => {
    // RFC 9110 says 1*DIGIT; Number() would take a hex literal as 16
    // seconds and an exponent as an hour.
    assert.equal(parseRetryAfter('0x10', NOW), null)
    assert.equal(parseRetryAfter('1e3', NOW), null)
  })

  it('reads an HTTP date, relative to now', () => {
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', NOW), 30_000)
  })

  it('floors a date already in the past', () => {
    // A clock skewed the wrong way must not produce a negative delay.
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', NOW + 5000), 0)
  })

  it('caps a wait long enough to park a concurrency slot', () => {
    assert.equal(parseRetryAfter('3600', NOW), 60_000)
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 01:00:00 GMT', NOW), 60_000)
  })

  it('returns null when there is nothing to read', () => {
    assert.equal(parseRetryAfter(null, NOW), null)
    assert.equal(parseRetryAfter(undefined, NOW), null)
    assert.equal(parseRetryAfter('', NOW), null)
    assert.equal(parseRetryAfter('soon', NOW), null)
  })
})

describe('retryDelayMs', () => {
  it('doubles per attempt, and jitters above the base rather than below', () => {
    // Lower bound is the backoff itself, upper bound the jitter ceiling:
    // waiting LESS than the base would defeat the backoff.
    for (const [attempt, base] of [[0, 1000], [1, 2000], [2, 4000], [3, 8000], [4, 16_000]]) {
      const wait = retryDelayMs(attempt)
      assert.ok(wait >= base && wait < base * 1.25, `attempt ${attempt}: ${wait}`)
    }
  })

  it('caps the backoff so a long budget does not stall the run', () => {
    for (const attempt of [5, 8, 20]) {
      const wait = retryDelayMs(attempt)
      assert.ok(wait >= 30_000 && wait < 37_500, `attempt ${attempt}: ${wait}`)
    }
  })

  it('takes the server at its word when it sends Retry-After', () => {
    // No jitter on this path: the number came from the server, and the
    // backoff is only a guess at the one it did not send.
    assert.equal(retryDelayMs(0, '7'), 7000)
    assert.equal(retryDelayMs(4, '7'), 7000)
  })

  it('never waits LESS than the flat second the old loop always took', () => {
    // `Retry-After: 0` is legal, and a negative delta or a date already
    // past under a second of clock skew clamps to the same 0. Returned
    // verbatim it spent the whole budget in milliseconds — a tighter
    // hammer on an upstream that just said stop than the flat retry this
    // backoff replaced.
    assert.equal(retryDelayMs(0, '0'), 1000)
    assert.equal(retryDelayMs(0, '-5'), 1000)
    assert.equal(retryDelayMs(3, 'Thu, 01 Jan 2020 00:00:00 GMT'), 1000)
  })

  it('falls back to the backoff for a Retry-After it cannot read', () => {
    assert.ok(retryDelayMs(1, 'whenever') >= 2000)
  })
})

describe('the retry budgets', () => {
  it('keeps the baseline every non-transient failure gets', () => {
    // --retries governs the transient class only, and is floored by this:
    // no failure retries fewer times than this, whatever the flag says.
    assert.equal(RETRIES, 2)
  })
})

// The loop itself, over a real socket: the helpers above are pure, and
// every bug this file was written after lived in how fetchJSON strings
// them together.
describe('fetchJSON retries', () => {
  let server
  let url
  let handler
  let requests
  let onRetryLogged
  let clock
  const errors = []
  const originalError = console.error

  // The handlers below keep the real timer. The clock is mocked for the
  // loop's backoff, and a server that is meant to drop a socket mid-body
  // has to do it whether or not the clock has been advanced — on the
  // mocked one it would be waiting for the very tick it has to cause.
  const realSetTimeout = globalThis.setTimeout

  before(async () => {
    server = http.createServer((req, res) => { requests++; handler(requests, res) })
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/`
    // The mock goes on HERE, one line before the loop schedules its wait,
    // and comes off as soon as that wait has been jumped — a window that
    // holds no I/O, only microtasks, so no request is ever in flight
    // across it. That is not tidiness. undici shares one dispatcher for
    // this whole file and caches the Timeout its internal clock ticks on,
    // refreshing that same handle forever rather than making a new one
    // (lib/util/timers.js, and its comment names mocked timers as the
    // case). A mock that is live when undici asks for a timer captures
    // that handle and then throws it away at reset, after which undici's
    // clock never advances again — and, two destroyed sockets later, its
    // reconnect never happens and the request simply never goes out. The
    // failure lands in a LATER test than the one that mocked the clock.
    console.error = (text) => {
      errors.push(text)
      clock?.enable({ apis: ['setTimeout'] })
      onRetryLogged?.()
    }
  })

  after(async () => {
    setFetchRetries()
    console.error = originalError
    await new Promise((resolve) => { server.close(resolve) })
  })

  // The loop announces each wait immediately before taking it:
  //
  //   [retry 1/4 in 1.0s] API 429: slow down
  //
  // which is both the assertion below and the cue to advance the clock,
  // read off the loop rather than a stub of it. A tenth of a second is all
  // the resolution it prints, so a jittered wait is checked by its bounds
  // and an exact one — the Retry-After floor, the flat second — to the
  // millisecond.
  const RETRY_LINE = /^\[retry \d+\/\d+ in (?<seconds>[\d.]+)s\]/u
  const waitsFrom = (lines) => lines
    .map((line) => RETRY_LINE.exec(line))
    .filter(Boolean)
    .map((match) => Number(match.groups.seconds) * 1000)

  // Waiting the backoff out for real cost this file ~15s, the whole suite's
  // runtime, and proved less than this does: elapsed wall-clock can only
  // ever say a wait was at LEAST so long. Only the clock is mocked — the
  // socket, the statuses, the classifier and the loop are the real ones.
  const call = async (t, h, retries) => {
    requests = 0
    errors.length = 0
    handler = h
    setFetchRetries(retries)
    clock = t.mock.timers

    let done = false
    const settled = fetchJSON(url, { method: 'POST', body: '{}' })
      .then(() => null, (e) => e)
      .finally(() => { done = true })
    const nextRetryLine = () => new Promise((resolve) => { onRetryLogged = resolve })

    // One jump clears any wait the loop can ask for — MAX_DELAY plus its
    // jitter is 37.5s — and the retry line says when there is one to
    // clear, so nothing here polls or guesses at how long a round trip
    // took. The next wake-up is armed before the tick that can produce it,
    // because tick() runs the timer synchronously while the loop's
    // continuation is a microtask behind it.
    for (;;) {
      await Promise.race([settled, nextRetryLine()])
      if (done) break
      clock.tick(60_000)
      clock.reset() // real timers again before the next attempt goes out
    }
    onRetryLogged = undefined
    clock = undefined
    t.mock.timers.reset()

    return { err: await settled, requests, errors, waits: waitsFrom(errors) }
  }

  it('spends the --retries budget on a transient failure, and floors a Retry-After of zero', async (t) => {
    // `Retry-After: 0` is legal and clamps to no wait at all; returned
    // verbatim the whole budget went in milliseconds. Flooring it at
    // BASE_DELAY is what the four waits below say — and they say it
    // exactly, where an `elapsed >= 4000ms` assertion would pass just as
    // happily on four waits of a second and a half.
    const { err, requests: n, waits: slept } = await call(t, (i, res) => {
      res.writeHead(429, { 'retry-after': '0' })
      res.end('slow down')
    }, 4)
    assert.equal(n, 5) // the attempt plus four re-asks
    assert.equal(err.status, 429)
    assert.deepEqual(slept, [1000, 1000, 1000, 1000])
  })

  it('keeps the status of a 5xx whose body read is cut mid-stream', async (t) => {
    // With the read inside the `new UpstreamError(...)` argument list, a
    // gateway dropping the socket after its headers rejects before the
    // error exists and the 503 arrives as a bare transport failure —
    // losing the very budget it is the reason for.
    const { err, requests: n, waits: slept } = await call(t, (i, res) => {
      res.writeHead(503, { 'content-length': '500' })
      res.flushHeaders()
      res.write('partial')
      realSetTimeout(() => { res.socket.destroy() }, 20)
    }, 1)
    assert.equal(n, RETRIES + 1) // --retries below the flat budget is floored by it
    assert.equal(err.status, 503)
    // Classified transient, so it backs off rather than taking the flat
    // second: the pair doubles, jitter and all. Bounds, not exact values —
    // the line prints tenths, so the 1.25s jitter ceiling reads as 1.3.
    assert.equal(slept.length, RETRIES)
    assert.ok(slept[0] >= 1000 && slept[0] < 1300, `${slept[0]}ms`)
    assert.ok(slept[1] >= 2000 && slept[1] < 2600, `${slept[1]}ms`)
  })

  it('does not let a transient prelude spend another class\'s budget', async (t) => {
    // Two failure classes, one counter: a shared counter lets the 503
    // consume the two tries the parse error is entitled to, leaving the
    // SyntaxError rethrown with none of its own.
    const { err, requests: n, waits: slept } = await call(t, (i, res) => {
      if (i === 1) { res.writeHead(503); res.end('down'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('<html>not json</html>')
    }, 1)
    assert.ok(err instanceof SyntaxError, `${err}`)
    assert.equal(n, 4) // the 503 and its re-ask, then the parse error and its own two
    // And the two classes pace differently: the 503 backs off, the parse
    // error keeps the flat second, so the waits also show the counters
    // were never shared.
    assert.ok(slept[0] >= 1000 && slept[0] < 1300, `${slept[0]}ms`)
    assert.deepEqual(slept.slice(1), [1000, 1000])
  })

  it('keeps the whole response body out of the retry line, and off the error', async (t) => {
    // server/scanner.ts keeps only the FIRST 64KB of a run's stderr, so a
    // per-attempt line carrying an echoed request body evicts the fatal
    // error that explains why the run died. And `Fatal: …` inspects the
    // thrown error itself: enumerable status/body would print that body a
    // second time, where a plain Error prints it once.
    const body = 'x'.repeat(5000)
    const { err, errors: logged } = await call(t, (i, res) => { res.writeHead(400); res.end(body) }, 1)
    assert.ok(logged.length > 0)
    for (const line of logged) assert.ok(line.length < 400, `${line.length} chars`)
    assert.ok(err.message.endsWith(body))
    assert.equal(JSON.stringify(err), '{}')
    assert.deepEqual(Object.keys(err), [])
    assert.equal(err.status, 400)
  })

  it('resolves a budget it cannot use back down to the flat one', async (t) => {
    // parsePositiveInt returns undefined for a flag that was never set;
    // stored unguarded that made the budget NaN and `used < NaN` false —
    // zero retries, not the RETRIES floor the comment promises.
    const { requests: n, waits: slept } = await call(t, (i, res) => { res.writeHead(503); res.end('down') }, undefined)
    assert.equal(n, RETRIES + 1)
    assert.equal(slept.length, RETRIES)
  })
})
