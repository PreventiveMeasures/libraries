import http from 'node:http'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { RETRIES, fetchJSON, isTransientHttpFailure, parseRetryAfter, retryDelayMs, setFetchRetries, setRetrySleep } from '../src/fetch.js'

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
    // used to fall through to Date.parse — which reads it as 2001-05-10,
    // i.e. a wait of zero out of a server asking for five seconds.
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
  it('keeps the baseline every non-transient failure has always had', () => {
    // --retries governs the transient class only, and is floored by this:
    // no failure retries less than it used to, whatever the flag says.
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
  const errors = []
  const waits = []
  const originalError = console.error

  before(async () => {
    server = http.createServer((req, res) => { requests++; handler(requests, res) })
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/`
    console.error = (text) => { errors.push(text) }
    // The backoff is recorded rather than slept. Every case below used to
    // pay its waits for real, which cost this file ~15s — the whole
    // suite's runtime — and bought a weaker assertion than this one: the
    // clock can only say a wait was at LEAST so long, while the number
    // the loop asked for is the thing the backoff is. The waits are the
    // only thing stubbed; the socket, the statuses and the loop are real.
    setRetrySleep((ms) => { waits.push(ms) })
  })

  after(async () => {
    setRetrySleep()
    setFetchRetries()
    console.error = originalError
    await new Promise((resolve) => { server.close(resolve) })
  })

  const call = async (h, retries) => {
    requests = 0
    errors.length = 0
    waits.length = 0
    handler = h
    setFetchRetries(retries)
    const err = await fetchJSON(url, { method: 'POST', body: '{}' }).then(() => null, (e) => e)
    return { err, requests, errors, waits }
  }

  it('spends the --retries budget on a transient failure, and floors a Retry-After of zero', async () => {
    // `Retry-After: 0` is legal and clamps to no wait at all; returned
    // verbatim the whole budget went in milliseconds. Flooring it at
    // BASE_DELAY is what the four waits below say — and they say it
    // exactly, where the elapsed >= 4000ms this replaced would have
    // passed just as happily on four waits of a second and a half.
    const { err, requests: n, waits: slept } = await call((i, res) => {
      res.writeHead(429, { 'retry-after': '0' })
      res.end('slow down')
    }, 4)
    assert.equal(n, 5) // the attempt plus four re-asks
    assert.equal(err.status, 429)
    assert.deepEqual(slept, [1000, 1000, 1000, 1000])
  })

  it('keeps the status of a 5xx whose body read is cut mid-stream', async () => {
    // The read used to sit inside the `new UpstreamError(...)` argument
    // list, so a gateway dropping the socket after its headers rejected
    // before the error existed and the 503 arrived as a bare transport
    // failure — losing the very budget it was the reason for.
    const { err, requests: n, waits: slept } = await call((i, res) => {
      res.writeHead(503, { 'content-length': '500' })
      res.flushHeaders()
      res.write('partial')
      setTimeout(() => { res.socket.destroy() }, 20)
    }, 1)
    assert.equal(n, RETRIES + 1) // --retries below the flat budget is floored by it
    assert.equal(err.status, 503)
    // Classified transient, so it backs off rather than taking the flat
    // second: the pair doubles, jitter and all.
    assert.equal(slept.length, RETRIES)
    assert.ok(slept[0] >= 1000 && slept[0] < 1250, `${slept[0]}ms`)
    assert.ok(slept[1] >= 2000 && slept[1] < 2500, `${slept[1]}ms`)
  })

  it('does not let a transient prelude spend another class\'s budget', async () => {
    // Two failure classes, one counter: the 503 used to consume the two
    // tries the parse error is entitled to, and the SyntaxError was
    // rethrown with none of its own left.
    const { err, requests: n, waits: slept } = await call((i, res) => {
      if (i === 1) { res.writeHead(503); res.end('down'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('<html>not json</html>')
    }, 1)
    assert.ok(err instanceof SyntaxError, `${err}`)
    assert.equal(n, 4) // the 503 and its re-ask, then the parse error and its own two
    // And the two classes pace differently: the 503 backs off, the parse
    // error keeps the flat second, so the waits also show the counters
    // were never shared.
    assert.ok(slept[0] >= 1000 && slept[0] < 1250, `${slept[0]}ms`)
    assert.deepEqual(slept.slice(1), [1000, 1000])
  })

  it('keeps the whole response body out of the retry line, and off the error', async () => {
    // server/scanner.ts keeps only the FIRST 64KB of a run's stderr, so a
    // per-attempt line carrying an echoed request body evicts the fatal
    // error that explains why the run died. And `Fatal: …` inspects the
    // thrown error itself: enumerable status/body would print that body a
    // second time, where the plain Error this replaced printed it once.
    const body = 'x'.repeat(5000)
    const { err, errors: logged } = await call((i, res) => { res.writeHead(400); res.end(body) }, 1)
    assert.ok(logged.length > 0)
    for (const line of logged) assert.ok(line.length < 400, `${line.length} chars`)
    assert.ok(err.message.endsWith(body))
    assert.equal(JSON.stringify(err), '{}')
    assert.deepEqual(Object.keys(err), [])
    assert.equal(err.status, 400)
  })

  it('resolves a budget it cannot use back down to the flat one', async () => {
    // parsePositiveInt returns undefined for a flag that was never set;
    // stored unguarded that made the budget NaN and `used < NaN` false —
    // zero retries, not the RETRIES floor the comment promises.
    const { requests: n, waits: slept } = await call((i, res) => { res.writeHead(503); res.end('down') }, undefined)
    assert.equal(n, RETRIES + 1)
    assert.equal(slept.length, RETRIES)
  })
})
