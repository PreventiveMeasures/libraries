import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { HttpError, npmAdvisories } from '../advisories.js'

const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// Answers each bulk request with `respond(body)`, and keeps every body.
function stubRegistry(respond) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), method: init.method, body })
    return Promise.resolve(Response.json(respond(body)))
  }
  return calls
}

const row = (overrides = {}) => ({
  id: 1,
  url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
  title: 'Prototype Pollution in minimist',
  severity: 'critical',
  vulnerable_versions: '>=1.0.0 <1.2.6',
  cwe: ['CWE-1321'],
  cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
  ...overrides,
})

describe('npmAdvisories', () => {
  it('answers one entry per package and range, with the asked versions it covers', async () => {
    const calls = stubRegistry(() => ({
      minimist: [row({ id: 1, vulnerable_versions: '<0.2.4' }), row({ id: 2 })],
      lodash: [row({ id: 3, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', vulnerable_versions: '<4.17.21', cwe: undefined, cvss: { score: 0, vectorString: null } })],
    }))
    const advisories = await npmAdvisories([
      { name: 'minimist', version: '1.2.0' },
      { name: 'lodash', version: '4.17.21' },
      { name: 'lodash', version: '4.17.15' },
      { name: 'minimist', version: '1.2.0' },
    ])
    assert.deepEqual(calls, [{ url: BULK, method: 'POST', body: { lodash: ['4.17.15', '4.17.21'], minimist: ['1.2.0'] } }])
    assert.deepEqual(advisories, [
      { name: 'lodash', id: 3, ghsa: 'GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', cwe: [], range: '<4.17.21', versions: ['4.17.15'] },
      { name: 'minimist', id: 2, ghsa: 'GHSA-xvch-5gv4-984h', title: 'Prototype Pollution in minimist', severity: 'critical', cvss: 9.8, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe: ['CWE-1321'], range: '>=1.0.0 <1.2.6', versions: ['1.2.0'] },
    ])
  })

  it('takes a GHSA only from a GitHub advisory page', async () => {
    stubRegistry(() => ({
      pkg: [
        row({ id: 1, url: 'https://npmjs.com/advisories/1' }),
        row({ id: 2, url: 'https://evil.example/advisories/GHSA-xvch-5gv4-984h' }),
        row({ id: 3, url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h/x' }),
      ],
    }))
    const advisories = await npmAdvisories([{ name: 'pkg', version: '1.0.0' }])
    assert.deepEqual(advisories.map((advisory) => [advisory.id, advisory.ghsa]), [[1, undefined], [2, undefined], [3, undefined]])
  })

  it('asks for 250 names at a time, in name order', async () => {
    const calls = stubRegistry(() => ({}))
    const names = Array.from({ length: 251 }, (_, i) => `pkg-${String(i).padStart(3, '0')}`)
    assert.deepEqual(await npmAdvisories(names.toReversed().map((name) => ({ name, version: '1.0.0' }))), [])
    assert.deepEqual(calls.map((call) => Object.keys(call.body)), [names.slice(0, 250), names.slice(250)])
  })

  it('makes no request for no packages', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    assert.deepEqual(await npmAdvisories([]), [])
    assert.deepEqual(calls, [])
  })

  it('refuses a malformed name or version, or anything but an iterable, before any request', async () => {
    const calls = stubRegistry(() => assert.fail('no request expected'))
    for (const packages of ['lodash', undefined, { name: 'lodash', version: '1.0.0' }]) {
      await assert.rejects(npmAdvisories(packages), /npmAdvisories: packages must be an iterable/u, String(packages))
    }
    for (const pkg of [null, { name: '../x', version: '1.0.0' }, { name: ['lodash'], version: '1.0.0' }, { version: '1.0.0' }]) {
      await assert.rejects(npmAdvisories([{ name: 'ok', version: '1.0.0' }, pkg]), /npmAdvisories: name must be an npm package name/u, JSON.stringify(pkg))
    }
    for (const version of ['^1.0.0', 'file:../x', '1.0.0+build', 'latest', undefined]) {
      await assert.rejects(npmAdvisories([{ name: 'lodash', version }]), /npmAdvisories: version must be an exact semver version/u, String(version))
    }
    assert.deepEqual(calls, [])
  })

  it('refuses an answer about a name not asked, or one that is malformed', async () => {
    for (const [answer, error] of [
      [[], /expected an object from the registry/u],
      [null, /expected an object from the registry/u],
      [{ other: [] }, /the registry answered for "other", which was not asked/u],
      [{ pkg: row() }, /malformed advisories for pkg/u],
      [{ pkg: [row({ id: '1' })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ url: null })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ vulnerable_versions: undefined })] }, /malformed advisories for pkg/u],
      [{ pkg: [row({ cwe: 'CWE-1321' })] }, /malformed advisories for pkg/u],
    ]) {
      stubRegistry(() => answer)
      await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }]), error, JSON.stringify(answer))
    }
  })

  it('throws an HttpError for a failed request', async () => {
    globalThis.fetch = () => Promise.resolve(Response.json({ error: 'nope' }, { status: 503 }))
    await assert.rejects(npmAdvisories([{ name: 'pkg', version: '1.0.0' }]), (err) => err instanceof HttpError && err.status === 503)
  })
})
