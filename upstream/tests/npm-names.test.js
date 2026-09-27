import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getGitHub, getTarball, resolvePackageRepos } from '../npm.js'

// Nothing reaches the registry, metadata included, until the name and
// the version are well-formed: strings, a name of the shape npm takes,
// and a version npm's semver.valid answers with unchanged. No cache is
// set in this file, and fetch fails the test if it is called at all.

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function forbidRequests() {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }
  return calls
}

// `['lodash']` is the one to watch: RegExp#test and a template literal
// both coerce it to `lodash`, so without the type check it would pass as
// a name and be requested as one.
const BAD_NAMES = [['lodash'], 42, undefined, null, { toString: () => 'lodash' }, '', '../lodash', 'lodash/../x', '@scope', '@scope/', 'a b', 'lodash?x', 'lodash#x']

const BAD_VERSIONS = [['1.0.0'], 100, undefined, null, '', 'latest', '^1.0.0', '1.0', '1.0.x', '01.0.0', 'v1.0.0', ' 1.0.0', '1.0.0 ', '1.0.0+build', '1.0.0/../x', '1.0.0?x']

describe('before any request to npm', () => {
  it('getGitHub refuses a malformed name', async () => {
    const calls = forbidRequests()
    for (const name of BAD_NAMES) {
      await assert.rejects(getGitHub(name), /Unexpected package name/u, String(name))
    }
    assert.deepEqual(calls, [])
  })

  it('resolvePackageRepos leaves a malformed name out, unasked', async () => {
    const calls = forbidRequests()
    assert.deepEqual([...await resolvePackageRepos(BAD_NAMES)], [])
    assert.deepEqual(calls, [])
  })

  it('getTarball refuses a malformed name', async () => {
    const calls = forbidRequests()
    for (const name of BAD_NAMES) {
      await assert.rejects(getTarball(name, '1.0.0'), /Unexpected package name/u, String(name))
    }
    assert.deepEqual(calls, [])
  })

  it('getTarball refuses a version semver does not spell exactly so', async () => {
    const calls = forbidRequests()
    for (const version of BAD_VERSIONS) {
      await assert.rejects(getTarball('lodash', version), /Unexpected package version/u, String(version))
    }
    assert.deepEqual(calls, [])
  })

  it('and asks for a well-formed one', async () => {
    // Capitals included: the rule is npm's for existing names, and
    // JSONStream was published long before new names had to be lowercase.
    const calls = forbidRequests()
    await assert.rejects(getGitHub('@scope/pkg.js'), /unexpected request/u)
    await assert.rejects(getTarball('@scope/pkg.js', '1.0.0-rc.1'), /unexpected request/u)
    await assert.rejects(getTarball('JSONStream', '1.3.5'), /unexpected request/u)
    assert.deepEqual(calls, [
      'https://registry.npmjs.org/@scope/pkg.js/latest',
      'https://registry.npmjs.org/@scope/pkg.js/1.0.0-rc.1',
      'https://registry.npmjs.org/JSONStream/1.3.5',
    ])
  })
})
