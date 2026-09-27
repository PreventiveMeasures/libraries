import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import { GITHUB_API, HttpError, NPM_REGISTRY, buildUrl, encodeSegment, request, send } from '../src/http.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('buildUrl', () => {
  it('joins checked segments under a known origin, and a query', () => {
    assert.equal(buildUrl(NPM_REGISTRY, ['@babel', 'core', '7.0.0-rc.1']), 'https://registry.npmjs.org/@babel/core/7.0.0-rc.1')
    assert.equal(buildUrl(GITHUB_API, ['repos', 'acme', 'app.js', 'contents', 'a%20b']), 'https://api.github.com/repos/acme/app.js/contents/a%20b')
    assert.equal(buildUrl(GITHUB_API, ['user', 'repos'], { per_page: 100, page: 2, sort: 'full_name' }), 'https://api.github.com/user/repos?per_page=100&page=2&sort=full_name')
    assert.equal(buildUrl(GITHUB_API, ['contents'], { ref: 'a b&c=d#e' }), 'https://api.github.com/contents?ref=a+b%26c%3Dd%23e')
  })

  it('refuses any origin but the ones this package talks to', () => {
    for (const origin of ['https://evil.example', 'http://registry.npmjs.org', 'https://api.github.com/', 'https://api.github.com.evil.example', 'https://github.com']) {
      assert.throws(() => buildUrl(origin, ['x']), /Unexpected origin/u, origin)
    }
  })

  it('refuses a segment that is not URL-safe, or is a dot segment in any spelling', () => {
    const bad = ['', '.', '..', 'a/b', 'a?b', 'a#b', 'a b', 'a\\b', '%2e%2e', '%2E%2e', '.%2e', '%2e.', '%2e', 'a%2', 'a%zz', 'ü', 42, undefined, null]
    for (const segment of bad) {
      assert.throws(() => buildUrl(GITHUB_API, ['repos', segment, 'x']), /Unexpected URL path segment|URL changed in parsing/u, String(segment))
    }
  })

  it('refuses a query key or value it does not expect', () => {
    assert.throws(() => buildUrl(GITHUB_API, ['x'], { 'a&b': 'c' }), /Unexpected query parameter/u)
    assert.throws(() => buildUrl(GITHUB_API, ['x'], { ref: '' }), /Unexpected query parameter/u)
    assert.throws(() => buildUrl(GITHUB_API, ['x'], { page: -1 }), /Unexpected query parameter/u)
    assert.throws(() => buildUrl(GITHUB_API, ['x'], { ref: ['a'] }), /Unexpected query parameter/u)
    assert.throws(() => buildUrl(GITHUB_API, []), /Expected path segments/u)
  })
})

describe('encodeSegment', () => {
  it('leaves only letters, digits, `-_.~` and escapes', () => {
    assert.equal(encodeSegment('feat/x'), 'feat%2Fx')
    assert.equal(encodeSegment("a b#c?d!e'f(g)h*i"), 'a%20b%23c%3Fd%21e%27f%28g%29h%2Ai')
    assert.equal(encodeSegment('%2e%2e'), '%252e%252e')
    assert.equal(encodeSegment('ü'), '%C3%BC')
  })

  it('leaves a dot segment a dot segment, for buildUrl to refuse', () => {
    assert.equal(encodeSegment('..'), '..')
    assert.throws(() => buildUrl(GITHUB_API, ['a', encodeSegment('..')]), /Unexpected URL path segment/u)
  })
})

describe('send and request', () => {
  const stub = (respond) => {
    const calls = []
    globalThis.fetch = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(respond(url, init))
    }
    return calls
  }

  it('sends only a URL buildUrl could have made', async () => {
    const calls = stub(() => new Response('{}'))
    for (const url of ['https://evil.example/x', 'https://user:pass@api.github.com/x', 'https://api.github.com/x#y', 'https://api.github.com/a/../b', 'HTTPS://API.GITHUB.COM/x', new URL('https://api.github.com/x')]) {
      await assert.rejects(send(url), String(url))
    }
    await assert.rejects(send(`${GITHUB_API}/x`, { method: 'DELETE' }), /Unexpected method/u)
    await assert.rejects(send(`${GITHUB_API}/x`, { redirect: 'error' }), /Unexpected redirect mode/u)
    assert.deepEqual(calls, [])
  })

  it('refuses redirects unless asked, and sends a JSON body as JSON', async () => {
    const calls = stub(() => new Response('{"ok":true}'))
    assert.deepEqual(await request(`${GITHUB_API}/x`, { as: 'json', method: 'POST', body: { a: 1 }, headers: { 'X-A': 'b' } }), { ok: true })
    assert.deepEqual(calls[0].init, { method: 'POST', redirect: 'manual', headers: { 'X-A': 'b', 'Content-Type': 'application/json' }, body: '{"a":1}' })
    await request(`${GITHUB_API}/x`, { as: 'text', redirect: 'follow' })
    assert.equal(calls[1].init.redirect, 'follow')
  })

  it('reads the body as the caller says, whatever its content type', async () => {
    stub(() => new Response('{"a":1}', { headers: { 'content-type': 'text/html' } }))
    assert.deepEqual(await request(`${NPM_REGISTRY}/x`, { as: 'json' }), { a: 1 })
    assert.equal(await request(`${NPM_REGISTRY}/x`, { as: 'text' }), '{"a":1}')
    assert.deepEqual(await request(`${NPM_REGISTRY}/x`, { as: 'bytes' }), new TextEncoder().encode('{"a":1}'))
    await assert.rejects(request(`${NPM_REGISTRY}/x`, {}), /Unexpected response type/u)
    stub(() => new Response('<html>'))
    await assert.rejects(request(`${NPM_REGISTRY}/x`, { as: 'json' }), /Malformed JSON from https:\/\/registry\.npmjs\.org\/x: <html>/u)
  })

  it('throws an HttpError for anything but a 2xx, a redirect included, with the start of the body', async () => {
    stub(() => new Response('x'.repeat(5000), { status: 500 }))
    await assert.rejects(request(`${GITHUB_API}/x`, { as: 'json' }), (err) => {
      assert.ok(err instanceof HttpError)
      assert.equal(err.status, 500)
      assert.equal(err.message, `GET ${GITHUB_API}/x 500: ${'x'.repeat(1000)}`)
      return true
    })
    stub(() => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }))
    await assert.rejects(request(`${GITHUB_API}/x`, { as: 'json' }), { name: 'HttpError', status: 302 })
  })
})

describe('src/', () => {
  it('calls fetch in http.js and nowhere else', () => {
    const dir = new URL('../src/', import.meta.url)
    const files = readdirSync(dir, { recursive: true }).filter((name) => name.endsWith('.js'))
    const callers = files.filter((name) => /\bfetch\s*\(/u.test(readFileSync(new URL(name, dir), 'utf8')))
    assert.deepEqual(callers, ['http.js'])
  })
})
