import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

import { yankedVersions } from '../cargo.js'
import { setCacheDir } from '../npm.js'
import { mapStore } from './cache-store.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// crates.io's sparse index: `index` is name -> its versions, each `vers`
// or `[vers, yanked]`, a Response as is; any other crate is a 404.
function stubIndex(index) {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    const name = Object.keys(index).find((key) => String(url).endsWith(`/${key.toLowerCase()}`))
    const answer = name === undefined ? undefined : index[name]
    if (answer instanceof Response) return Promise.resolve(answer.clone())
    if (answer === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    const lines = answer.map((entry) => [entry].flat()).map(([vers, yanked = false]) => JSON.stringify({ name, vers, deps: [], cksum: '0'.repeat(64), features: {}, yanked }))
    return Promise.resolve(new Response(lines.join('\n')))
  }
  return calls
}

const crate = (name, versions) => ({ name, versions })

describe('yankedVersions', () => {
  it('answers each crate its yanked versions and those the index lacks, one request a crate', async () => {
    const calls = stubIndex({ time: ['0.2.2', ['0.2.3', true], '0.3.0'], log: [['0.4.0', true], '0.4.1'] })
    const found = await yankedVersions([crate('time', ['0.2.3', '0.3.0', '9.9.9']), crate('log', ['0.4.1']), crate('time', ['0.2.3', '0.2.2'])], { cache: false })
    assert.deepEqual(found, new Map([
      ['time', { yanked: ['0.2.3'], unknown: ['9.9.9'] }],
      ['log', { yanked: [], unknown: [] }],
    ]))
    assert.deepEqual(calls.toSorted(), ['https://index.crates.io/3/l/log', 'https://index.crates.io/ti/me/time'])
  })

  it("answers every version of a crate the index doesn't have unknown, and keeps nothing of it", async () => {
    const store = mapStore()
    stubIndex({})
    assert.deepEqual(await yankedVersions([crate('private-crate', ['1.0.0', '2.0.0'])], { cache: store }), new Map([['private-crate', { yanked: [], unknown: ['1.0.0', '2.0.0'] }]]))
    assert.deepEqual(store.log.filter(([op]) => op === 'write'), [])
  })

  it("keeps a crate's versions 90 minutes in a caller's store, a yank being news", async () => {
    const store = mapStore()
    let calls = stubIndex({ serde: ['1.0.0', ['1.0.1', true]] })
    await yankedVersions([crate('serde', ['1.0.1'])], { cache: store })
    assert.deepEqual(store.get('cargo/index', 'serde'), { at: store.get('cargo/index', 'serde').at, name: 'serde', published: ['1.0.0'], yanked: ['1.0.1'] })
    calls = stubIndex({ serde: ['1.0.0', '1.0.1'] })
    assert.deepEqual(await yankedVersions([crate('serde', ['1.0.1'])], { cache: store }), new Map([['serde', { yanked: ['1.0.1'], unknown: [] }]]))
    assert.deepEqual(calls, [])
    store.set('cargo/index', 'serde', { ...store.get('cargo/index', 'serde'), at: Date.now() - 91 * 60 * 1000 })
    calls = stubIndex({ serde: ['1.0.0', '1.0.1'] })
    assert.deepEqual(await yankedVersions([crate('serde', ['1.0.1'])], { cache: store }), new Map([['serde', { yanked: [], unknown: [] }]]))
    assert.equal(calls.length, 1)
  })

  describe('through the cache', () => {
    let dir
    after(async () => {
      setCacheDir(false)
      await rm(dir, { recursive: true, force: true })
    })

    it("keeps a crate's versions for the next run", async () => {
      dir = await mkdtemp(join(tmpdir(), 'upstream-yanked-cache-'))
      setCacheDir(dir)
      stubIndex({ rand: [['0.8.0', true]] })
      await yankedVersions([crate('rand', ['0.8.0'])])
      assert.deepEqual(await readdir(join(dir, 'cargo', 'index')), ['rand.json'])
      const calls = stubIndex({})
      assert.deepEqual(await yankedVersions([crate('rand', ['0.8.0'])]), new Map([['rand', { yanked: ['0.8.0'], unknown: [] }]]))
      assert.deepEqual(calls, [])
    })
  })

  it('throws where the index fails, answers for another crate, or has a malformed line', async () => {
    stubIndex({ time: new Response('busy', { status: 500 }) })
    await assert.rejects(yankedVersions([crate('time', ['0.3.0'])], { cache: false }), { name: 'HttpError', status: 500 })
    stubIndex({ Time: ['0.3.0'] })
    await assert.rejects(yankedVersions([crate('time', ['0.3.0'])], { cache: false }), /yankedVersions: the index answered for "Time", not time/u)
    stubIndex({ time: new Response(JSON.stringify({ name: 'time', vers: '0.3.0', yanked: 'no' })) })
    await assert.rejects(yankedVersions([crate('time', ['0.3.0'])], { cache: false }), /yankedVersions: malformed index line for time/u)
    stubIndex({ time: new Response('{"name":"time"\n') })
    await assert.rejects(yankedVersions([crate('time', ['0.3.0'])], { cache: false }), /yankedVersions: the index for time has a line that is not JSON/u)
  })

  it('refuses a malformed crate, version or option before any request', async () => {
    const calls = stubIndex({})
    for (const [crates, options, message] of [
      [[crate('-bad', ['1.0.0'])], {}, /yankedVersions: crate\.name must be a crate name/u],
      [[crate('time', ['1.0'])], {}, /yankedVersions: crate\.versions must be a semver version/u],
      [[crate('time', [])], {}, /yankedVersions: crate\.versions must be a non-empty array/u],
      [[{ name: 'time', versions: ['1.0.0'], source: 'git' }], {}, /yankedVersions: unknown option crate\.source/u],
      ['time', {}, /yankedVersions: crates must be an iterable/u],
      [[], { cachedOnly: true }, /yankedVersions: unknown option cachedOnly/u],
      [[], { cache: 'dir' }, /yankedVersions: cache must be false, or a store/u],
    ]) {
      await assert.rejects(yankedVersions(crates, options), message, JSON.stringify(crates))
    }
    assert.deepEqual(calls, [])
  })
})
