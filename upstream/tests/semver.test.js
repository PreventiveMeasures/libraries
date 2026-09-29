import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { compareVersions, intersects, isExactVersion, satisfies, valid, validRange } from '../semver.js'

// Against the npm that ships beside the node running this, which every
// install these tests run on has.
const semver = createRequire(import.meta.url)(resolve(dirname(process.argv[0]), '../lib/node_modules/npm/node_modules/semver'))

describe("npm's semver, borrowed", () => {
  it("answers as semver does, options and all", () => {
    assert.equal(satisfies('4.17.20', '<4.17.21'), true)
    assert.equal(satisfies('4.17.21', '<4.17.21'), false)
    assert.equal(satisfies('4.17.20-rc.1', '<4.17.21'), false)
    assert.equal(satisfies('4.17.20-rc.1', '<4.17.21', { includePrerelease: true }), true)
    assert.equal(satisfies('1.0.0', 'not a range'), false)
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
    assert.deepEqual(['1.10.0', '1.2.0', '1.9.0'].toSorted(compareVersions), ['1.2.0', '1.9.0', '1.10.0'])
    assert.throws(() => compareVersions('file:a', 'file:b'), /Invalid Version/u)
    assert.equal(validRange('^1.2.0'), '>=1.2.0 <2.0.0-0')
    assert.equal(validRange('1.x || >=3'), '>=1.0.0 <2.0.0-0||>=3.0.0')
    assert.equal(validRange('latest'), null)
    assert.equal(validRange('npm:foo@1'), null)
    for (const range of ['^1.2.0', '*', '', 'latest', 'x.y', '>=1 <2']) assert.equal(validRange(range), semver.validRange(range))
    assert.equal(intersects('^1.2.0', '1.5.0'), true)
    assert.equal(intersects('^1.2.0', '^2.0.0'), false)
    assert.throws(() => intersects('^1', 'latest'), /Invalid comparator/u)
  })
})

describe('valid', () => {
  // The fast path answers without semver, so it may only ever answer what
  // semver would: every string here, and a few thousand random ones, is
  // checked against semver.valid itself.
  const EDGES = [
    '0.0.0', '1.2.3', '10.20.30', '999999999999999.0.0', '0.999999999999999.0', '9007199254740991.0.0', '9007199254740992.0.0',
    '9999999999999999.1.1', '01.2.3', '1.02.3', '1.2.03', '00.0.0', '1.2', '1.2.3.4', '1..3', '.1.2', '1.2.', '-1.2.3', '+1.2.3',
    'v1.2.3', '=1.2.3', ' 1.2.3', '1.2.3 ', '1.2.3\n', '\n1.2.3', '1.2.3-0', '1.2.3-rc.1', '1.2.3-01', '1.2.3+build', '1.2.3-a+b',
    '１.2.3', '1.2.3\u0000', '', 'latest', '*', '^1.2.3', '1.x', `1.2.${'1'.repeat(300)}`,
  ]
  let seed = 7
  const next = (n) => { seed = (seed * 48271) % 2147483647; return seed % n }
  const PIECES = ['0', '1', '9', '01', '10', '123456789012345', '1234567890123456', '.', '.', '.', '-', '+', 'rc', 'v', ' ', 'x']
  const RANDOM = Array.from({ length: 3000 }, () => Array.from({ length: 1 + next(7) }, () => PIECES[next(PIECES.length)]).join(''))

  it('answers exactly what semver.valid answers', () => {
    for (const version of [...EDGES, ...RANDOM]) assert.equal(valid(version), semver.valid(version), JSON.stringify(version))
    for (const version of [undefined, null, 42, ['1.2.3']]) assert.equal(valid(version), semver.valid(version), String(version))
  })

  it('answers what semver.valid answers with options too, invalid ones included', () => {
    for (const options of [{}, { loose: true }, { includePrerelease: true }, true, false, 'loose', 42, null]) {
      for (const version of EDGES) assert.equal(valid(version, options), semver.valid(version, options), `${JSON.stringify(version)} ${JSON.stringify(options)}`)
    }
  })

  it('counts as exact only what semver spells unchanged', () => {
    for (const version of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3-beta.2']) assert.equal(isExactVersion(version), true, version)
    for (const version of ['v1.2.3', ' 1.2.3', '1.2.3+build.5', '01.2.3', '1.2', '^1.2.3', '', 123, undefined]) assert.equal(isExactVersion(version), false, String(version))
  })
})
