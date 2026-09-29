import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMatcher } from '../src/matcher.js'
import { depPathToFilename } from '../src/pnpm/filename.js'

// Each pair is a snapshot key and the directory pnpm 10.33.4 made of it
// under node_modules/.pnpm, read off a real install.
const REAL = [
  ['react@18.2.0', 120, 'react@18.2.0'],
  ['@testing-library/dom@9.3.4', 120, '@testing-library+dom@9.3.4'],
  ['@testing-library/react@14.1.2(react-dom@18.2.0(react@18.2.0))(react@18.2.0)', 120, '@testing-library+react@14.1.2_react-dom@18.2.0_react@18.2.0__react@18.2.0'],
  ['JSONStream@1.3.5', 120, 'JSONStream@1.3.5_fb8f73c374dcf7070ffed90b688edabd'],
  ['is-number@7.0.0(patch_hash=f8221cac75c6c7db111947ff4f6f7586d75e265bddc330ea1e0472bda441abfe)', 120, 'is-number@7.0.0_patch_hash=f8221cac75c6c7db111947ff4f6f7586d75e265bddc330ea1e0472bda441abfe'],
  ['Base64@1.1.0', 40, 'Base64@_950ea81a481263637c8a891d69ea0671'],
  ['ms@2.1.3', 40, 'ms@2.1.3'],
]

describe('depPathToFilename', () => {
  for (const [key, max, dir] of REAL) {
    it(`${key} at ${max}`, async () => {
      assert.equal(await depPathToFilename(key, max), dir)
    })
  }

  // TextEncoder writes a lone surrogate as U+FFFD, so it would hash as
  // another key does.
  it('refuses to hash a key that is not well-formed text', async () => {
    await assert.rejects(depPathToFilename('A@1.0.0(\uD800)', 120), /^DeptreeError: "A@1\.0\.0\(\\ud800\)": expected well-formed text to hash$/u)
  })

  // pnpm 11 makes a trailing dot or space `+` and hashes, as its own
  // depPathToFilename answers for these; pnpm 10 leaves them.
  it('escapes a trailing dot or space as pnpm 11 does', async () => {
    const PNPM_11 = [
      ['a@1.0.0.', 120, 'a@1.0.0+_f24ca05381a71dc7fd19078ac0a6a304'],
      ['a@1.0.0 ', 120, 'a@1.0.0+_debea321e14781cf7056df11d1293e11'],
      ['a@1.0.0(b@1.0.0.)', 120, 'a@1.0.0_b@1.0.0+_6d9f192d8da8c4446c134075b85fe376'],
      ['a@1.0.0(b@1.0.0.)', 40, 'a@1.0.0_6d9f192d8da8c4446c134075b85fe376'],
      ['A@1.0.0', 120, 'A@1.0.0_030f5287fa75dd4cda2fe675a140bfac'],
    ]
    for (const [key, max, dir] of PNPM_11) assert.equal(await depPathToFilename(key, max, 11), dir, key)
    assert.equal(await depPathToFilename('a@1.0.0.', 120, 10), 'a@1.0.0.')
  })

  it('cuts a long one to the length, hash included', async () => {
    const dir = await depPathToFilename(`a@1.0.0(${'b'.repeat(200)}@1.0.0)`, 120)
    assert.equal(dir.length, 120)
    assert.match(dir, /^a@1\.0\.0_b+_[\da-f]{32}$/u)
  })
})

describe('createMatcher', () => {
  const cases = [
    [['*'], ['anything'], []],
    [[], [], ['anything']],
    [['*eslint*'], ['eslint', '@types/eslint', 'eslint-plugin-x'], ['prettier']],
    [['a.b'], ['a.b'], ['axb']],
    [['!@babel/*'], ['react'], ['@babel/core']],
    [['*', '!@babel/*'], ['react'], ['@babel/core']],
    [['!a', '!b'], ['c'], ['a', 'b']],
    [['!a', 'a'], ['a'], ['b']],
  ]
  for (const [patterns, matched, unmatched] of cases) {
    it(JSON.stringify(patterns), () => {
      const match = createMatcher(patterns)
      for (const name of matched) assert.equal(match(name), true, name)
      for (const name of unmatched) assert.equal(match(name), false, name)
    })
  }
})
