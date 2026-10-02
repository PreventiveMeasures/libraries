import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeptreeError } from '../src/error.js'
import { own, readManifest, readManifests } from '../src/manifest.js'
import { createMatcher } from '../src/matcher.js'
import { matchesGlob } from '../src/glob.js'
import { checkWorkspace } from '../src/pnpm/workspace.js'
import { Hoister } from '../src/yarn1/hoist.js'

// What a project's own files may make of a builder, held to bounds: no
// path out of the project, no nesting or chain that runs a recursion out of
// stack, no name read from Object.prototype, no glob that takes a regexp's
// time to backtrack.

const nested = (depth) => `${'{"x":'.repeat(depth)}{}${'}'.repeat(depth)}`

describe('package.json', () => {
  it('given only for the project and directories under it', () => {
    for (const dir of ['../w', 'a/../../w', '', './a', '/a', 'a/', 'a//b']) {
      assert.throws(() => readManifests({ '.': '{}', [dir]: '{}' }), (error) => error instanceof DeptreeError && error.where === `manifests[${JSON.stringify(dir)}]`)
    }
    assert.deepEqual([...readManifests(new Map([['.', '{}'], ['packages/w', '{}']])).keys()], ['.', 'packages/w'])
  })

  it('nested no deeper than any is', () => {
    assert.throws(() => readManifest(nested(20_000), 'm'), /^DeptreeError: m: nested more than 100 deep, which is not supported$/u)
    assert.throws(() => readManifest(`{"a":${'['.repeat(100)}${']'.repeat(100)}}`, 'm'), /nested more than 100 deep/u)
    readManifest(nested(99), 'm')
  })

  it('read for its own names alone', () => {
    const { dependencies } = readManifest('{"dependencies":{"a":"1.0.0"}}', 'm')
    assert.equal(own(dependencies, 'a'), '1.0.0')
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(own(dependencies, name), undefined)
    assert.equal(own(readManifest('{"__proto__":"x"}', 'm'), '__proto__'), 'x')
    assert.equal(own(undefined, 'a'), undefined)
  })
})

describe('a glob or a name pattern', () => {
  // As a regexp, each of these takes hours.
  it('matched in time linear in the name', () => {
    const glob = '*a*a*a*a*a*a*a*a*b'
    const start = performance.now()
    assert.equal(createMatcher([glob])('a'.repeat(214)), false)
    assert.equal(matchesGlob(glob, 'a'.repeat(255)), false)
    assert.throws(() => checkWorkspace(['a'.repeat(255)], [glob]), /do not take this directory/u)
    assert.ok(performance.now() - start < 1000)
  })

  it('matched as before', () => {
    const name = createMatcher(['@s/*', 'a*b', '!a-b'])
    assert.deepEqual(['@s/x', '@s/', 'axb', 'a-b', 'ab', 'a\nb', 'a?b'].map(name), [true, true, true, false, true, false, true])
    assert.equal(createMatcher(['a?b'])('axb'), false)
    assert.deepEqual(['x', '.x', 'xy'].map((path) => matchesGlob('?', path)), [true, false, false])
    assert.deepEqual(['a', '.a', 'b/.c', 'b/c'].map((path) => matchesGlob('**/*', path)), [true, false, false, true])
    assert.deepEqual(['.a', 'a.b'].map((path) => matchesGlob('.*', path)), [true, false])
  })
})

describe('a chain of dependencies', () => {
  const chain = (length) => new Map(Array.from({ length }, (_, i) => [`p${i}@1.0.0`, { name: `p${i}`, version: '1.0.0', dependencies: i + 1 < length ? [`p${i + 1}@1.0.0`] : [] }]))

  // yarn's prepass recurses down each, keeping its ancestry.
  it('hoisted by yarn up to a depth no package graph has', () => {
    new Hoister(chain(1000), () => []).prepass(['p0@1.0.0'])
    assert.throws(() => new Hoister(chain(20_000), () => []).prepass(['p0@1.0.0']), /^DeptreeError: "p1000@1\.0\.0": a chain of more than 1000 dependencies is not supported$/u)
  })
})
