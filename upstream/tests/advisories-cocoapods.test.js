import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

import { advisories } from '../advisories.js'
import { createClient } from '../github.js'
import { setCacheDir } from '../npm.js'
import { mapStore } from './cache-store.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const github = createClient({ token: 'test-token' })
const listing = (repo) => `https://api.github.com/repos/${repo}/security-advisories?state=published&per_page=100`
// Where trunk's CDN has a version's podspec, sharded by the md5 of the name.
const podspecUrl = (name, version) => `https://cdn.cocoapods.org/Specs/${[...createHash('md5').update(name).digest('hex').slice(0, 3)].join('/')}/${name}/${version}/${name}.podspec.json`
const isPodspec = (url) => url.startsWith('https://cdn.cocoapods.org/')
const pod = (name, versions, rest = {}) => ({ ecosystem: 'cocoapods', name, versions, ...rest })
const options = { github }

// Trunk and GitHub, each answering from what is given: `podspecs` is
// `name@version` -> the podspec's `source` and `homepage` (a Response as
// is), and `listings` repo -> its listing. `calls` is every request, with
// the redirect mode it was made with.
function stubAll({ podspecs = {}, listings = {} } = {}) {
  const calls = []
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    calls.push({ url, redirect: init.redirect })
    const spec = Object.entries(podspecs).find(([key]) => url === podspecUrl(...key.split('@')))
    if (spec) {
      const [name, version] = spec[0].split('@')
      return Promise.resolve(spec[1] instanceof Response ? spec[1].clone() : Response.json({ name, version, ...spec[1] }))
    }
    if (isPodspec(url)) return Promise.resolve(new Response('404: Not Found', { status: 404 }))
    const listed = Object.entries(listings).find(([repo]) => url === listing(repo))
    if (listed) return Promise.resolve(Response.json(listed[1]))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

const repoAdvisory = (id, vulnerabilities) => ({ ghsa_id: id, state: 'published', summary: `Advisory ${id}`, severity: 'high', vulnerabilities })
const vuln = (ecosystem, name, range, patched) => ({ package: { ecosystem, name }, vulnerable_version_range: range, ...(patched !== undefined && { patched_versions: patched }) })

describe('cocoapods', () => {
  it("lists the advisories of the repository its newest version's podspec names, every range counting, matched as Gem::Version", async () => {
    const calls = stubAll({
      podspecs: { 'Alamofire@5.10.0': { source: { git: 'https://github.com/Alamofire/Alamofire.git', tag: '5.10.0' }, homepage: 'https://github.com/Alamofire/other' } },
      listings: {
        'Alamofire/Alamofire': [
          // Filed under the Swift package, as a pod's repository files them.
          repoAdvisory('GHSA-aaaa-aaaa-aaaa', [vuln('swift', 'github.com/Alamofire/Alamofire', '< 5.9.1')]),
          // 4.0 is 4.0.0, and outside, where semver would take it for any
          // version.
          repoAdvisory('GHSA-bbbb-bbbb-bbbb', [vuln('npm', 'alamofire', '>= 5.0.0')]),
          // Ended below its one patched version.
          repoAdvisory('GHSA-cccc-cccc-cccc', [vuln('swift', 'github.com/Alamofire/Alamofire', '>= 4.0', '5.9.1')]),
        ],
      },
    })
    const found = await advisories([pod('Alamofire', ['5.9.1', '4.0', '5.10.0'])], options)
    assert.deepEqual(calls.filter(({ url }) => isPodspec(url)), [{ url: podspecUrl('Alamofire', '5.10.0'), redirect: 'follow' }])
    assert.deepEqual(found.map(({ ecosystem, source, id, url, range, versions }) => [ecosystem, source, id, url, range, versions]), [
      ['cocoapods', 'repository', 'GHSA-aaaa-aaaa-aaaa', 'https://github.com/Alamofire/Alamofire/security/advisories/GHSA-aaaa-aaaa-aaaa', '< 5.9.1', ['4.0']],
      ['cocoapods', 'repository', 'GHSA-bbbb-bbbb-bbbb', 'https://github.com/Alamofire/Alamofire/security/advisories/GHSA-bbbb-bbbb-bbbb', '>= 5.0.0', ['5.9.1', '5.10.0']],
      ['cocoapods', 'repository', 'GHSA-cccc-cccc-cccc', 'https://github.com/Alamofire/Alamofire/security/advisories/GHSA-cccc-cccc-cccc', '>= 4.0, < 5.9.1', ['4.0']],
    ])
  })

  it("takes the podspec's source by :git, else by :http on GitHub, else its homepage; one trunk does not have, or naming none, asks no repository", async () => {
    const calls = stubAll({
      podspecs: {
        'A@1.0': { source: { git: 'https://github.com/acme/a.git', tag: '1.0' } },
        'B@1.0': { source: { git: 'git@github.com:acme/b.git', tag: '1.0' } },
        'C@1.0': { source: { http: 'https://github.com/acme/c/releases/download/1.0/C.zip' }, homepage: 'https://acme.example' },
        'D@1.0': { source: { http: 'https://dl.acme.example/D.zip' }, homepage: 'https://github.com/acme/d' },
        'E@1.0': { source: { git: 'https://gitlab.com/acme/e.git' }, homepage: 'https://acme.example/e' },
      },
      listings: { 'acme/a': [], 'acme/b': [], 'acme/c': [], 'acme/d': [] },
    })
    const names = ['A', 'B', 'C', 'D', 'E', 'NotOnTrunk']
    assert.deepEqual(await advisories(names.map((name) => pod(name, ['1.0'])), options), [])
    assert.deepEqual(calls.filter(({ url }) => isPodspec(url)).map(({ url }) => url).toSorted(), names.map((name) => podspecUrl(name, '1.0')).toSorted())
    assert.deepEqual(calls.filter(({ url }) => !isPodspec(url)).map(({ url }) => url).toSorted(), [listing('acme/a'), listing('acme/b'), listing('acme/c'), listing('acme/d')])
  })

  it('asks the repository a pod is given without looking it up', async () => {
    const calls = stubAll({ listings: { 'acme/local': [repoAdvisory('GHSA-dddd-dddd-dddd', [vuln('swift', 'github.com/acme/local', '< 2')])] } })
    const found = await advisories([pod('Local', ['1.0.0'], { github: 'acme/local' })], options)
    assert.deepEqual(calls.map(({ url }) => url), [listing('acme/local')])
    assert.deepEqual(found.map(({ id, versions }) => [id, versions]), [['GHSA-dddd-dddd-dddd', ['1.0.0']]])
  })

  it('refuses a subspec, a malformed name or version, and a call without a GitHub client, before any request', async () => {
    const calls = stubAll()
    for (const name of ['Firebase/Core', '.hidden', 'a b', 'a(b)', '', 'x'.repeat(1025), undefined]) {
      await assert.rejects(advisories([pod(name, ['1.0.0'])], options), /advisories: package\.name must be a pod's root name/u, String(name))
    }
    for (const version of ['', 'v1.0', '1.0 beta', '1..0', '1'.repeat(257), undefined]) {
      await assert.rejects(advisories([pod('Alamofire', [version])], options), /advisories: package\.versions must be a CocoaPods version/u, String(version))
    }
    await assert.rejects(advisories([pod('Alamofire', ['5.9.1'])]), /advisories: cocoapods packages need a github client/u)
    assert.deepEqual(calls, [])
  })

  it('throws where trunk fails, or answers for another pod or version', async () => {
    stubAll({ podspecs: { 'Alamofire@5.9.1': Response.json({ error: 'busy' }, { status: 503 }) } })
    await assert.rejects(advisories([pod('Alamofire', ['5.9.1'])], options), { name: 'HttpError', status: 503 })
    stubAll({ podspecs: { 'Alamofire@5.9.1': Response.json({ name: 'AFNetworking', version: '5.9.1' }) } })
    await assert.rejects(advisories([pod('Alamofire', ['5.9.1'])], options), /advisories: trunk answered for "AFNetworking" "5\.9\.1", not Alamofire 5\.9\.1/u)
  })

  it("keeps a pod's repository a month in a caller's store, and none it did not find", async () => {
    const store = mapStore()
    const answers = { podspecs: { 'Alamofire@5.9.1': { source: { git: 'https://github.com/Alamofire/Alamofire.git' } } }, listings: { 'Alamofire/Alamofire': [] } }
    const packages = [pod('Alamofire', ['5.9.1']), pod('Gone', ['1.0'])]
    stubAll(answers)
    await advisories(packages, { ...options, cache: store })
    assert.equal(store.get('cocoapods/repos', 'Alamofire')?.github, 'Alamofire/Alamofire')
    assert.deepEqual(store.log.filter(([op, type]) => op === 'write' && type === 'cocoapods/repos').map(([, , key]) => key), ['Alamofire'])
    let calls = stubAll(answers)
    await advisories(packages, { ...options, cache: store })
    assert.deepEqual(calls.filter(({ url }) => isPodspec(url)).map(({ url }) => url), [podspecUrl('Gone', '1.0')])
    store.set('cocoapods/repos', 'Alamofire', { at: Date.now() - 31 * 24 * 60 * 60 * 1000, name: 'Alamofire', github: 'Alamofire/Alamofire' })
    calls = stubAll(answers)
    await advisories([pod('Alamofire', ['5.9.1'])], { ...options, cache: store })
    assert.deepEqual(calls.filter(({ url }) => isPodspec(url)).map(({ url }) => url), [podspecUrl('Alamofire', '5.9.1')])
  })

  describe('through the cache', () => {
    let dir
    after(async () => {
      setCacheDir(false)
      await rm(dir, { recursive: true, force: true })
    })

    it("keeps a pod's repository for the next run", async () => {
      dir = await mkdtemp(join(tmpdir(), 'upstream-pod-cache-'))
      setCacheDir(dir)
      const answers = { podspecs: { 'Alamofire@5.9.1': { source: { git: 'https://github.com/Alamofire/Alamofire.git' } } }, listings: { 'Alamofire/Alamofire': [] } }
      stubAll(answers)
      await advisories([pod('Alamofire', ['5.9.1'])], options)
      assert.deepEqual(await readdir(join(dir, 'cocoapods', 'repos')), ['!alamofire.json'])
      const calls = stubAll({ ...answers, podspecs: {} })
      await advisories([pod('Alamofire', ['5.9.1'])], options)
      assert.deepEqual(calls.map(({ url }) => url), [])
    })
  })
})
