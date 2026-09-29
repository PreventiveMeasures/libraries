import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseOverrides, parseSelector } from '../src/pnpm/overrides.js'

// Selectors as pnpm 10 parses them (@pnpm/parse-overrides): a package, a
// range after its `@`, and a parent before a `>` that follows anything but
// a space, `|` or `@`.
describe('parseSelector', () => {
  const read = [
    ['foo', { target: { name: 'foo', range: undefined } }],
    ['foo@1', { target: { name: 'foo', range: '1' } }],
    ['@s/foo@^1.2.0', { target: { name: '@s/foo', range: '^1.2.0' } }],
    ['foo@>1 <2', { target: { name: 'foo', range: '>1 <2' } }],
    ['foo@1 || >2', { target: { name: 'foo', range: '1 || >2' } }],
    ['bar>foo', { parent: { name: 'bar', range: undefined }, target: { name: 'foo', range: undefined } }],
    ['bar@2>foo@1', { parent: { name: 'bar', range: '2' }, target: { name: 'foo', range: '1' } }],
    ['@s/bar@^2.1.0>@t/foo', { parent: { name: '@s/bar', range: '^2.1.0' }, target: { name: '@t/foo', range: undefined } }],
    ['foo@', { target: { name: 'foo', range: '' } }],
  ]
  for (const [selector, parsed] of read) {
    it(selector, () => assert.deepEqual(parseSelector(selector, 'x'), parsed))
  }

  // Yarn's globs among them, which pnpm reads resolutions as selectors and
  // cannot parse.
  for (const selector of ['**/foo', 'foo/**/bar', '.foo', '_foo', 'node_modules', ' foo', 'a>b>c', '@s/', 'f o o']) {
    it(`refuses ${JSON.stringify(selector)}`, () => {
      assert.throws(() => parseSelector(selector, 'x'), /^DeptreeError: x: pnpm cannot parse the selector/u)
    })
  }
})

describe('parseOverrides', () => {
  const catalogs = { __proto__: null, default: { foo: '^1.0.0', rec: 'catalog:', ws: 'workspace:*', ln: 'link:../x' }, next: { foo: '^2.0.0' } }

  it('resolves a catalog for the package a selector targets', () => {
    assert.deepEqual({ ...parseOverrides({ foo: 'catalog:', 'bar>foo': 'catalog:next', baz: '1.0.0', qux: '-' }, catalogs) }, { foo: '^1.0.0', 'bar>foo': '^2.0.0', baz: '1.0.0', qux: '-' })
  })

  it('refuses a catalog pnpm cannot resolve', () => {
    assert.throws(() => parseOverrides({ bar: 'catalog:' }, catalogs), /^DeptreeError: overrides\["bar"\]: pnpm cannot resolve a catalog in the overrides: catalog "default" has no entry for "bar"$/u)
    assert.throws(() => parseOverrides({ rec: 'catalog:' }, catalogs), /is itself a catalog reference/u)
    assert.throws(() => parseOverrides({ ws: 'catalog:' }, catalogs), /uses a protocol pnpm refuses/u)
    assert.throws(() => parseOverrides({ ln: 'catalog:' }, catalogs), /uses a protocol pnpm refuses/u)
    assert.throws(() => parseOverrides({ foo: 'catalog:nope' }, catalogs), /catalog "nope" has no entry/u)
  })
})
